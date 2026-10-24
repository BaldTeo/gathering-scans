#!/usr/bin/env python3
"""
GatheringScans Windows Workstation Controller & System Tray App (`daemon_watchdog.py`).

Features:
1. Windows System Tray Icon (Notification Area) with live status indicator:
   - Green badge when Online & Streaming (`127.0.0.1:8095` + VPS Reverse Tunnel)
   - Amber badge when Paused (`daemon_running = False`)
   - Right-click menu:
     * Status header (Online / Paused)
     * Open Local Studio (http://127.0.0.1:8095)
     * Open Cloud Website (https://scans.gatheren.cloud)
     * Pause / Resume Background Daemon (syncs with `data/daemon_state.json` & Web UI)
     * View Live Log (`data/daemon_stdout.log`)
     * Stop Server & Exit Completely (terminates server + watchdog so it NEVER restarts automatically)
2. Respects `data/daemon_state.json`:
   - If stopped/paused from the Web UI or CLI (`daemon_running == False`), does not auto-spawn the worker.
   - If `watchdog_exit == True` (or `--stop` CLI flag passed), terminates both `start_gathering_scans.py`
     and `daemon_watchdog.py` immediately.
"""

import ctypes
from ctypes import wintypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from typing import Any, Dict, Optional, Tuple

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
LAUNCHER_SCRIPT = os.path.join(BASE_DIR, "start_gathering_scans.py")
LOG_FILE = os.path.join(DATA_DIR, "daemon_watchdog.log")
STDOUT_LOG_FILE = os.path.join(DATA_DIR, "daemon_stdout.log")
DAEMON_STATE_PATH = os.path.join(DATA_DIR, "daemon_state.json")
PID_LOCK_PATH = os.path.join(DATA_DIR, "daemon_watchdog.pid")

_WIN_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0


def log_msg(msg: str) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as lf:
            lf.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def read_daemon_state() -> Dict[str, Any]:
    default_state: Dict[str, Any] = {
        "daemon_running": True,
        "watchdog_exit": False,
        "updated_at": time.time(),
        "updated_by": "system",
    }
    if os.path.isfile(DAEMON_STATE_PATH):
        try:
            with open(DAEMON_STATE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                default_state.update(data)
        except Exception:
            pass
    return default_state


def write_daemon_state(daemon_running: bool, watchdog_exit: bool = False, actor: str = "tray") -> Dict[str, Any]:
    os.makedirs(DATA_DIR, exist_ok=True)
    state = {
        "daemon_running": bool(daemon_running),
        "watchdog_exit": bool(watchdog_exit),
        "updated_at": time.time(),
        "updated_by": actor,
    }
    try:
        with open(DAEMON_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
    except Exception as e:
        log_msg(f"Warning writing daemon_state.json: {e}")
    return state


def is_port_open(port: int = 8095) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.5):
            return True
    except OSError:
        return False


def notify_server_daemon_state(running: bool) -> None:
    """Notifies running server.py of the updated daemon state so the Web UI chip updates immediately."""
    if not is_port_open(8095):
        return
    try:
        if BASE_DIR not in sys.path:
            sys.path.insert(0, BASE_DIR)
        from pc_worker.config import TUNNEL_SHARED_KEY

        body = json.dumps({"action": "start" if running else "stop"}).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:8095/api/admin/pc-daemon",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Tunnel-Key": TUNNEL_SHARED_KEY,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2.5) as _:
            pass
    except Exception:
        pass


def kill_all_gathering_scans_processes(include_self: bool = False) -> None:
    """Terminates any running start_gathering_scans.py / server.py (and optionally other watchdog instances)."""
    if os.name != "nt":
        return
    my_pid = os.getpid()
    ps_script = (
        "Get-CimInstance Win32_Process | Where-Object { "
        "$_.Name -match 'python|ssh' -and $_.ProcessId -ne " + str(my_pid) + " -and "
        "($_.CommandLine -match 'start_gathering_scans\\.py|GatheringScans\\\\server\\.py|id_gathering_vps'"
        + (" -or $_.CommandLine -match 'daemon_watchdog\\.py'" if include_self else "")
        + ") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            timeout=8,
            creationflags=_WIN_NO_WINDOW,
        )
    except Exception as e:
        log_msg(f"Process cleanup warning: {e}")


class GatheringScansController:
    def __init__(self) -> None:
        self.child_proc: Optional[subprocess.Popen] = None
        self.should_quit = False
        self.lock = threading.Lock()
        self.tray: Optional["Win32SystemTray"] = None

    def start_server_if_needed(self) -> None:
        with self.lock:
            if self.should_quit:
                return
            state = read_daemon_state()
            if state.get("watchdog_exit"):
                log_msg("watchdog_exit=True detected in daemon_state.json; shutting down.")
                self.stop_and_exit()
                return

            # Always keep HTTP server (port 8095) running while controller is active unless watchdog_exit is set,
            # so Web UI can still be opened when paused, OR if user wants server running only when daemon_running=True:
            if not is_port_open(8095):
                log_msg(f"Port 8095 offline; launching {LAUNCHER_SCRIPT}")
                try:
                    os.makedirs(DATA_DIR, exist_ok=True)
                    out_log = open(STDOUT_LOG_FILE, "a", encoding="utf-8")
                    creationflags = 0
                    if os.name == "nt":
                        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | _WIN_NO_WINDOW
                    self.child_proc = subprocess.Popen(
                        [sys.executable, "-u", LAUNCHER_SCRIPT],
                        cwd=BASE_DIR,
                        stdin=subprocess.DEVNULL,
                        stdout=out_log,
                        stderr=subprocess.STDOUT,
                        creationflags=creationflags,
                    )
                except Exception as e:
                    log_msg(f"Failed to launch server: {e}")

    def toggle_pause_resume(self) -> None:
        state = read_daemon_state()
        new_running = not bool(state.get("daemon_running", True))
        write_daemon_state(daemon_running=new_running, watchdog_exit=False, actor="system_tray")
        notify_server_daemon_state(new_running)
        log_msg(f"User toggled daemon_running -> {new_running} via System Tray")
        if self.tray:
            self.tray.update_icon_and_tooltip()

    def stop_and_exit(self) -> None:
        self.should_quit = True
        write_daemon_state(daemon_running=False, watchdog_exit=True, actor="system_tray_exit")
        log_msg("Stopping GatheringScans server and exiting watchdog completely.")
        if self.child_proc and self.child_proc.poll() is None:
            try:
                self.child_proc.terminate()
            except Exception:
                pass
        kill_all_gathering_scans_processes(include_self=False)
        try:
            if os.path.isfile(PID_LOCK_PATH):
                os.remove(PID_LOCK_PATH)
        except OSError:
            pass
        if self.tray:
            self.tray.close()

    def watchdog_loop(self) -> None:
        # Ensure daemon starts in running state when explicitly launched by user
        write_daemon_state(daemon_running=True, watchdog_exit=False, actor="startup")
        while not self.should_quit:
            try:
                state = read_daemon_state()
                if state.get("watchdog_exit"):
                    self.stop_and_exit()
                    break
                if not is_port_open(8095):
                    self.start_server_if_needed()
                    for _ in range(10):
                        if self.should_quit or is_port_open(8095):
                            break
                        time.sleep(1.0)
                    if is_port_open(8095):
                        notify_server_daemon_state(bool(state.get("daemon_running", True)))
                if self.tray:
                    self.tray.update_icon_and_tooltip()
            except Exception as e:
                log_msg(f"Watchdog loop error: {e}")
            for _ in range(10):
                if self.should_quit:
                    break
                time.sleep(0.5)


# ============================================================================
# Native Win32 System Tray Icon (Pure Python ctypes — Zero External Packages)
# ============================================================================
if os.name == "nt":
    user32 = ctypes.windll.user32
    shell32 = ctypes.windll.shell32
    kernel32 = ctypes.windll.kernel32
    gdi32 = ctypes.windll.gdi32

    WM_DESTROY = 0x0002
    WM_CLOSE = 0x0010
    WM_COMMAND = 0x0111
    WM_USER = 0x0400
    WM_TRAYICON = WM_USER + 20
    WM_LBUTTONDBLCLK = 0x0203
    WM_RBUTTONUP = 0x0205
    WM_CONTEXTMENU = 0x007B

    NIM_ADD = 0x00000000
    NIM_MODIFY = 0x00000001
    NIM_DELETE = 0x00000002
    NIF_MESSAGE = 0x00000001
    NIF_ICON = 0x00000002
    NIF_TIP = 0x00000004
    NIF_INFO = 0x00000010

    MF_STRING = 0x00000000
    MF_SEPARATOR = 0x00000800
    MF_GRAYED = 0x00000001
    TPM_LEFTALIGN = 0x0000
    TPM_BOTTOMALIGN = 0x0020
    TPM_RIGHTBUTTON = 0x0002
    TPM_RETURNCMD = 0x0100

    IDI_APPLICATION = 32512
    IDI_INFORMATION = 32516
    IDI_WARNING = 32515

    ID_CMD_OPEN_LOCAL = 1001
    ID_CMD_OPEN_CLOUD = 1002
    ID_CMD_TOGGLE_PAUSE = 1003
    ID_CMD_VIEW_LOGS = 1004
    ID_CMD_STOP_EXIT = 1005

    WNDPROCTYPE = ctypes.WINFUNCTYPE(
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
    )

    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.DefWindowProcW.restype = ctypes.c_ssize_t

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROCTYPE),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", wintypes.WCHAR * 256),
            ("uTimeoutOrVersion", wintypes.UINT),
            ("szInfoTitle", wintypes.WCHAR * 64),
            ("dwInfoFlags", wintypes.DWORD),
        ]

    def _create_colored_badge_icon(rgb_hex: int) -> wintypes.HICON:
        """Creates a crisp 16x16 colored 3D-cube badge HICON in memory using GDI."""
        try:
            w, h = 16, 16
            hdc_screen = user32.GetDC(None)
            hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
            hbmp_color = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
            hbmp_mask = gdi32.CreateBitmap(w, h, 1, 1, None)

            old_bmp = gdi32.SelectObject(hdc_mem, hbmp_color)
            r = (rgb_hex >> 16) & 0xFF
            g = (rgb_hex >> 8) & 0xFF
            b = rgb_hex & 0xFF
            colorref = r | (g << 8) | (b << 16)
            border_ref = 0x201810

            brush_bg = gdi32.CreateSolidBrush(border_ref)
            brush_fg = gdi32.CreateSolidBrush(colorref)
            rect_outer = wintypes.RECT(1, 1, 15, 15)
            rect_inner = wintypes.RECT(3, 3, 13, 13)
            user32.FillRect(hdc_mem, ctypes.byref(rect_outer), brush_bg)
            user32.FillRect(hdc_mem, ctypes.byref(rect_inner), brush_fg)

            gdi32.DeleteObject(brush_fg)
            gdi32.DeleteObject(brush_bg)
            gdi32.SelectObject(hdc_mem, old_bmp)
            gdi32.DeleteDC(hdc_mem)
            user32.ReleaseDC(None, hdc_screen)

            class ICONINFO(ctypes.Structure):
                _fields_ = [
                    ("fIcon", wintypes.BOOL),
                    ("xHotspot", wintypes.DWORD),
                    ("yHotspot", wintypes.DWORD),
                    ("hbmMask", wintypes.HBITMAP),
                    ("hbmColor", wintypes.HBITMAP),
                ]

            ii = ICONINFO(True, 0, 0, hbmp_mask, hbmp_color)
            hicon = user32.CreateIconIndirect(ctypes.byref(ii))
            gdi32.DeleteObject(hbmp_color)
            gdi32.DeleteObject(hbmp_mask)
            if hicon:
                return hicon
        except Exception:
            pass
        return user32.LoadIconW(None, ctypes.cast(IDI_INFORMATION, wintypes.LPCWSTR))

    class Win32SystemTray:
        def __init__(self, controller: GatheringScansController) -> None:
            self.controller = controller
            self.hwnd: Optional[wintypes.HWND] = None
            self.nid: Optional[NOTIFYICONDATAW] = None
            self.icon_online = _create_colored_badge_icon(0x10B981)  # Emerald Green
            self.icon_paused = _create_colored_badge_icon(0xF59E0B)  # Amber Orange
            self._wndproc_ref = WNDPROCTYPE(self._wnd_proc)

        def _get_status_summary(self) -> Tuple[bool, bool, str]:
            state = read_daemon_state()
            daemon_on = bool(state.get("daemon_running", True))
            port_up = is_port_open(8095)
            if daemon_on and port_up:
                tip = "GatheringScans Daemon: ONLINE (Port 8095 · Right-click to control)"
            elif not daemon_on:
                tip = "GatheringScans Daemon: PAUSED (Right-click to Resume or Exit)"
            else:
                tip = "GatheringScans Daemon: Starting local server on port 8095..."
            return daemon_on, port_up, tip

        def update_icon_and_tooltip(self) -> None:
            if not self.hwnd or not self.nid:
                return
            daemon_on, port_up, tip = self._get_status_summary()
            self.nid.hIcon = self.icon_online if (daemon_on and port_up) else self.icon_paused
            self.nid.szTip = tip[:127]
            self.nid.uFlags = NIF_ICON | NIF_TIP
            shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(self.nid))

        def _show_context_menu(self) -> None:
            if not self.hwnd:
                return
            daemon_on, port_up, _ = self._get_status_summary()
            hmenu = user32.CreatePopupMenu()
            status_txt = (
                "GatheringScans: ONLINE (Port 8095)"
                if (daemon_on and port_up)
                else ("GatheringScans: PAUSED" if not daemon_on else "GatheringScans: Starting...")
            )
            user32.AppendMenuW(hmenu, MF_STRING | MF_GRAYED, 0, status_txt)
            user32.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(hmenu, MF_STRING, ID_CMD_OPEN_LOCAL, "Open Local Studio (http://127.0.0.1:8095)")
            user32.AppendMenuW(hmenu, MF_STRING, ID_CMD_OPEN_CLOUD, "Open Cloud Website (https://scans.gatheren.cloud)")
            user32.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
            toggle_lbl = "Pause Background Daemon" if daemon_on else "Resume Background Daemon"
            user32.AppendMenuW(hmenu, MF_STRING, ID_CMD_TOGGLE_PAUSE, toggle_lbl)
            user32.AppendMenuW(hmenu, MF_STRING, ID_CMD_VIEW_LOGS, "View Live Log (daemon_stdout.log)")
            user32.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(hmenu, MF_STRING, ID_CMD_STOP_EXIT, "Stop Server && Exit Completely")

            pt = wintypes.POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            user32.SetForegroundWindow(self.hwnd)
            cmd = user32.TrackPopupMenu(
                hmenu,
                TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD,
                pt.x,
                pt.y,
                0,
                self.hwnd,
                None,
            )
            user32.DestroyMenu(hmenu)

            if cmd == ID_CMD_OPEN_LOCAL:
                webbrowser.open("http://127.0.0.1:8095")
            elif cmd == ID_CMD_OPEN_CLOUD:
                webbrowser.open("https://scans.gatheren.cloud")
            elif cmd == ID_CMD_TOGGLE_PAUSE:
                threading.Thread(target=self.controller.toggle_pause_resume, daemon=True).start()
            elif cmd == ID_CMD_VIEW_LOGS:
                if os.path.isfile(STDOUT_LOG_FILE):
                    os.startfile(STDOUT_LOG_FILE)
                elif os.path.isfile(LOG_FILE):
                    os.startfile(LOG_FILE)
            elif cmd == ID_CMD_STOP_EXIT:
                threading.Thread(target=self.controller.stop_and_exit, daemon=True).start()

        def _wnd_proc(self, hwnd: int, msg: int, wparam: int, lparam: int) -> int:
            if msg == WM_TRAYICON:
                if lparam == WM_LBUTTONDBLCLK:
                    webbrowser.open("http://127.0.0.1:8095")
                    return 0
                if lparam in (WM_RBUTTONUP, WM_CONTEXTMENU):
                    self._show_context_menu()
                    return 0
            elif msg == WM_CLOSE:
                user32.DestroyWindow(hwnd)
                return 0
            elif msg == WM_DESTROY:
                if self.nid:
                    shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self.nid))
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        def close(self) -> None:
            if self.hwnd:
                user32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)

        def run_message_loop(self) -> None:
            hinst = kernel32.GetModuleHandleW(None)
            class_name = f"GatheringScansTrayWnd_{os.getpid()}"
            wc = WNDCLASSW()
            wc.lpfnWndProc = self._wndproc_ref
            wc.hInstance = hinst
            wc.lpszClassName = class_name
            user32.RegisterClassW(ctypes.byref(wc))

            self.hwnd = user32.CreateWindowExW(
                0, class_name, "GatheringScans Tray Controller", 0, 0, 0, 0, 0, None, None, hinst, None
            )

            _, _, tip = self._get_status_summary()
            self.nid = NOTIFYICONDATAW()
            self.nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
            self.nid.hWnd = self.hwnd
            self.nid.uID = 1
            self.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_INFO
            self.nid.uCallbackMessage = WM_TRAYICON
            self.nid.hIcon = self.icon_online
            self.nid.szTip = tip[:127]
            self.nid.szInfoTitle = "GatheringScans Daemon Online"
            self.nid.szInfo = "Running in system tray (port 8095). Right-click the green tray icon to Pause or Stop & Exit."
            self.nid.dwInfoFlags = 1  # NIIF_INFO
            shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(self.nid))

            msg = wintypes.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))


def main() -> None:
    if "--stop" in sys.argv:
        write_daemon_state(daemon_running=False, watchdog_exit=True, actor="cli_stop")
        kill_all_gathering_scans_processes(include_self=True)
        print("GatheringScans daemon and watchdog stopped completely.")
        return

    # Prevent duplicate watchdog instances
    kill_all_gathering_scans_processes(include_self=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(PID_LOCK_PATH, "w", encoding="utf-8") as pf:
        pf.write(str(os.getpid()))

    controller = GatheringScansController()
    t_watchdog = threading.Thread(target=controller.watchdog_loop, daemon=True)
    t_watchdog.start()

    if os.name == "nt":
        tray = Win32SystemTray(controller)
        controller.tray = tray
        tray.run_message_loop()
    else:
        while not controller.should_quit:
            time.sleep(2.0)


if __name__ == "__main__":
    main()
