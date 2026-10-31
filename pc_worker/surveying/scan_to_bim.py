#!/usr/bin/env python3
"""
GatheringScans — Scan-to-BIM Simplified Classified Geometric Model & Exporters
File: pc_worker/surveying/scan_to_bim.py
Compliance: Pure Python standard library, strictly under 5,000 lines modular ceiling.

Capabilities:
1. Geometric Primitive Fitting:
   - Fits simplified parametric solids to classified scan elements:
     * Buildings & Structures -> 3D Bounding Cuboids / Extruded Footprint Prisms
     * Walls & Fences -> 3D Extruded Wall Prisms (length, height, thickness, strike azimuth)
     * Roads & Sidewalks -> 3D Surface Road Ribbons & Subgrade Prisms
     * Trees -> Vertical Cylindrical Trunks (DBH at 1.3m) + Triangulated Canopy Ellipsoids
     * Water Bodies -> Planar Water Boundaries & Bathymetric Hydrostatic Prisms
     * Pipes & Utilities -> 3D Cylindrical Pipe Solids (invert, slope, diameter)
2. Pure Python Standard Library Exporters:
   - ISO-10303-21 IFC SPF (IFC4 schema, standard spatial hierarchy, Brep solids, styled items)
   - 3D AutoCAD DXF (R12/2000 ASCII format, 3DFACE solids, categorized layers & ACI colors)
   - Wavefront OBJ + MTL (Grouped meshes with semantic materials and transparency)
3. Interface Contracts:
   - fit_scan_to_bim_primitives(payload) -> Dict[str, Any]
   - export_scan_to_bim(payload) -> Dict[str, Any]
"""

from __future__ import annotations

import os
import sys
import math
import uuid
import json
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Tuple, Optional, Set

from pc_worker.config import (
    REPORTS_DIR,
    CONTOURS_DIR,
    CATEGORIZATION_CACHE_DIR,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
)

# ---------------------------------------------------------------------------
# IFC 22-Character GUID Helper (ISO-10303-21 standard)
# ---------------------------------------------------------------------------
_IFC_BASE64_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def create_ifc_guid() -> str:
    """Generate valid 22-character IFC Base64 GUID from UUID4 (ISO-10303-21 standard)."""
    u = uuid.uuid4().int
    chars = []
    # 128 bits: first character has 2 bits (126..127), then 21 chars have 6 bits each
    for i in range(22):
        if i == 0:
            val = (u >> 126) & 0x03
        else:
            val = (u >> ((21 - i) * 6)) & 0x3F
        chars.append(_IFC_BASE64_CHARS[val])
    return "".join(chars)


# ---------------------------------------------------------------------------
# Computational Geometry Helpers (Pure Python Standard Library)
# ---------------------------------------------------------------------------
def _polygon_area_2d(pts: List[Tuple[float, float]]) -> float:
    """Compute 2D polygon signed area via shoelace formula."""
    n = len(pts)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return area * 0.5


def _is_point_in_triangle_2d(
    px: float, py: float,
    ax: float, ay: float,
    bx: float, by: float,
    cx: float, cy: float,
) -> bool:
    """Check if point (px, py) is strictly inside 2D triangle (A, B, C)."""
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    has_neg = (d1 < -1e-9) or (d2 < -1e-9) or (d3 < -1e-9)
    has_pos = (d1 > 1e-9) or (d2 > 1e-9) or (d3 > 1e-9)
    return not (has_neg and has_pos)


def _triangulate_polygon_earclipping(pts_2d: List[Tuple[float, float]]) -> List[Tuple[int, int, int]]:
    """
    Robust pure Python ear-clipping triangulation for simple polygons without self-intersections.
    Returns list of 0-based index triplets into pts_2d.
    """
    n = len(pts_2d)
    if n < 3:
        return []
    if n == 3:
        return [(0, 1, 2)]

    area = _polygon_area_2d(pts_2d)
    indices = list(range(n))
    if area < 0:
        # Counter-clockwise orientation needed
        indices.reverse()

    triangles: List[Tuple[int, int, int]] = []
    max_iters = n * 5
    iter_count = 0

    while len(indices) > 3 and iter_count < max_iters:
        iter_count += 1
        ear_found = False
        k = len(indices)
        for i in range(k):
            prev_idx = indices[(i - 1 + k) % k]
            curr_idx = indices[i]
            next_idx = indices[(i + 1) % k]

            ax, ay = pts_2d[prev_idx]
            bx, by = pts_2d[curr_idx]
            cx, cy = pts_2d[next_idx]

            # Cross product must be strictly convex
            cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
            if cross <= 1e-9:
                continue

            # Check if any other polygon vertex is inside this ear
            contains_other = False
            for j in range(k):
                if j in ((i - 1 + k) % k, i, (i + 1) % k):
                    continue
                px, py = pts_2d[indices[j]]
                if _is_point_in_triangle_2d(px, py, ax, ay, bx, by, cx, cy):
                    contains_other = True
                    break

            if not contains_other:
                triangles.append((prev_idx, curr_idx, next_idx))
                indices.pop(i)
                ear_found = True
                break

        if not ear_found:
            # Fallback for noisy non-convex boundary: fan triangulation from first remaining vertex
            for fi in range(1, len(indices) - 1):
                triangles.append((indices[0], indices[fi], indices[fi + 1]))
            break

    if len(indices) == 3:
        triangles.append((indices[0], indices[1], indices[2]))

    return triangles


def _generate_cylinder_mesh(
    base_center: Tuple[float, float, float],
    radius: float,
    height: float,
    radial_segments: int = 12,
) -> Dict[str, Any]:
    """Generate pure Python cylindrical solid mesh with top and bottom circular caps."""
    cx, cy, cz = base_center
    r = max(0.02, float(radius))
    h = max(0.05, float(height))
    verts: List[Tuple[float, float, float]] = []
    faces: List[Tuple[int, int, int]] = []

    # Bottom ring vertices (0 .. N-1)
    for i in range(radial_segments):
        ang = 2.0 * math.pi * float(i) / float(radial_segments)
        verts.append((cx + r * math.cos(ang), cy + r * math.sin(ang), cz))

    # Top ring vertices (N .. 2N-1)
    for i in range(radial_segments):
        ang = 2.0 * math.pi * float(i) / float(radial_segments)
        verts.append((cx + r * math.cos(ang), cy + r * math.sin(ang), cz + h))

    # Bottom center (2N) and Top center (2N+1)
    b_center_idx = len(verts)
    verts.append((cx, cy, cz))
    t_center_idx = len(verts)
    verts.append((cx, cy, cz + h))

    # Side quad faces (split into 2 triangles)
    for i in range(radial_segments):
        nxt = (i + 1) % radial_segments
        b0 = i
        b1 = nxt
        t0 = i + radial_segments
        t1 = nxt + radial_segments
        faces.append((b0, b1, t1))
        faces.append((b0, t1, t0))

    # Bottom cap fan (facing downwards)
    for i in range(radial_segments):
        nxt = (i + 1) % radial_segments
        faces.append((b_center_idx, nxt, i))

    # Top cap fan (facing upwards)
    for i in range(radial_segments):
        nxt = (i + 1) % radial_segments
        faces.append((t_center_idx, i + radial_segments, nxt + radial_segments))

    return {
        "vertices": verts,
        "faces": faces,
    }


def _generate_ellipsoid_mesh(
    center: Tuple[float, float, float],
    rx: float,
    ry: float,
    rz: float,
    lat_segs: int = 8,
    lon_segs: int = 12,
) -> Dict[str, Any]:
    """Generate pure Python triangulated UV ellipsoid solid mesh."""
    cx, cy, cz = center
    rx = max(0.1, float(rx))
    ry = max(0.1, float(ry))
    rz = max(0.1, float(rz))
    verts: List[Tuple[float, float, float]] = []
    faces: List[Tuple[int, int, int]] = []

    # South pole vertex
    verts.append((cx, cy, cz - rz))

    # Intermediate latitude rings
    for u in range(1, lat_segs):
        phi = -math.pi * 0.5 + math.pi * float(u) / float(lat_segs)
        cp = math.cos(phi)
        sp = math.sin(phi)
        for v in range(lon_segs):
            theta = 2.0 * math.pi * float(v) / float(lon_segs)
            x = cx + rx * cp * math.cos(theta)
            y = cy + ry * cp * math.sin(theta)
            z = cz + rz * sp
            verts.append((x, y, z))

    # North pole vertex
    verts.append((cx, cy, cz + rz))
    north_pole_idx = len(verts) - 1

    # Connect south pole to first ring (outward CCW normals)
    for v in range(lon_segs):
        nxt = (v + 1) % lon_segs
        faces.append((0, 1 + nxt, 1 + v))

    # Connect intermediate rings (outward CCW normals)
    for u in range(lat_segs - 2):
        r0 = 1 + u * lon_segs
        r1 = 1 + (u + 1) * lon_segs
        for v in range(lon_segs):
            nxt = (v + 1) % lon_segs
            p0 = r0 + v
            p1 = r0 + nxt
            p2 = r1 + v
            p3 = r1 + nxt
            faces.append((p0, p1, p3))
            faces.append((p0, p3, p2))

    # Connect top ring to north pole (outward CCW normals)
    last_ring_start = 1 + (lat_segs - 2) * lon_segs
    for v in range(lon_segs):
        nxt = (v + 1) % lon_segs
        faces.append((north_pole_idx, last_ring_start + v, last_ring_start + nxt))

    return {
        "vertices": verts,
        "faces": faces,
    }


def _generate_box_mesh(
    center: Tuple[float, float, float],
    dx: float,
    dy: float,
    dz: float,
    azimuth_deg: float = 0.0,
) -> Dict[str, Any]:
    """Generate pure Python oriented 3D rectangular cuboid solid mesh."""
    cx, cy, cz = center
    hx, hy, hz = dx * 0.5, dy * 0.5, dz * 0.5
    ang = math.radians(azimuth_deg)
    ca, sa = math.cos(ang), math.sin(ang)

    # 8 local box corners
    local_corners = [
        (-hx, -hy, -hz),
        (hx, -hy, -hz),
        (hx, hy, -hz),
        (-hx, hy, -hz),
        (-hx, -hy, hz),
        (hx, -hy, hz),
        (hx, hy, hz),
        (-hx, hy, hz),
    ]

    verts: List[Tuple[float, float, float]] = []
    for lx, ly, lz in local_corners:
        rx = lx * ca - ly * sa
        ry = lx * sa + ly * ca
        verts.append((cx + rx, cy + ry, cz + lz))

    faces = [
        # Bottom (-Z)
        (0, 2, 1), (0, 3, 2),
        # Top (+Z)
        (4, 5, 6), (4, 6, 7),
        # Front (-Y)
        (0, 1, 5), (0, 5, 4),
        # Back (+Y)
        (2, 3, 7), (2, 7, 6),
        # Left (-X)
        (3, 0, 4), (3, 4, 7),
        # Right (+X)
        (1, 2, 6), (1, 6, 5),
    ]

    return {
        "vertices": verts,
        "faces": faces,
    }


def _generate_extruded_polygon_mesh(
    boundary_3d: List[Tuple[float, float, float]],
    extrusion_depth: float = 0.25,
    extrude_direction: str = "down",
) -> Dict[str, Any]:
    """
    Extrude a 3D polygonal boundary into a closed 3D solid prism.
    Triangulates the top cap, creates offset bottom cap, and connects side skirts.
    """
    n = len(boundary_3d)
    if n < 3:
        return {"vertices": [], "faces": []}

    # Remove duplicated closing vertex if present
    pts = list(boundary_3d)
    if len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 1e-4 and abs(pts[0][1] - pts[-1][1]) < 1e-4:
        pts.pop()
    n = len(pts)
    if n < 3:
        return {"vertices": [], "faces": []}

    pts_2d = [(p[0], p[1]) for p in pts]
    if _polygon_area_2d(pts_2d) < 0:
        pts.reverse()
        pts_2d = [(p[0], p[1]) for p in pts]
    top_faces = _triangulate_polygon_earclipping(pts_2d)

    sign = -1.0 if extrude_direction == "down" else 1.0
    dz = float(extrusion_depth) * sign

    verts: List[Tuple[float, float, float]] = []
    # Vertices 0 .. n-1: top for down, bottom for up
    for p in pts:
        verts.append((p[0], p[1], p[2]))

    # Vertices n .. 2n-1: bottom for down, top for up
    for p in pts:
        verts.append((p[0], p[1], p[2] + dz))

    faces: List[Tuple[int, int, int]] = []

    if sign < 0:
        # Downward extrusion: 0..n-1 is top (higher Z), n..2n-1 is bottom (lower Z)
        # Top cap facing +Z (outward CCW)
        faces.extend(top_faces)
        # Bottom cap facing -Z (outward CCW from exterior)
        for a, b, c in top_faces:
            faces.append((c + n, b + n, a + n))
        # Side wall skirts
        for i in range(n):
            nxt = (i + 1) % n
            t0 = i
            t1 = nxt
            b0 = i + n
            b1 = nxt + n
            faces.append((t0, b0, b1))
            faces.append((t0, b1, t1))
    else:
        # Upward extrusion: 0..n-1 is bottom (lower Z), n..2n-1 is top (higher Z)
        # Bottom cap facing -Z
        for a, b, c in top_faces:
            faces.append((c, b, a))
        # Top cap facing +Z
        for a, b, c in top_faces:
            faces.append((a + n, b + n, c + n))
        # Side wall skirts
        for i in range(n):
            nxt = (i + 1) % n
            b0 = i
            b1 = nxt
            t0 = i + n
            t1 = nxt + n
            faces.append((b0, b1, t1))
            faces.append((b0, t1, t0))

    return {
        "vertices": verts,
        "faces": faces,
    }


def _generate_extruded_wall_prism_mesh(
    base_polyline: List[Tuple[float, float, float]],
    top_polyline: List[Tuple[float, float, float]],
    thickness_m: float = 0.25,
) -> Dict[str, Any]:
    """
    Extrude a continuous wall polyline with measured base and top elevations by thickness_m
    along the transverse normal vectors to generate an exact 3D structural wall prism.
    """
    n = len(base_polyline)
    if n < 2 or len(top_polyline) < 2:
        return {"vertices": [], "faces": []}

    pts_count = min(n, len(top_polyline))
    half_t = max(0.05, float(thickness_m) * 0.5)

    left_base: List[Tuple[float, float, float]] = []
    right_base: List[Tuple[float, float, float]] = []
    left_top: List[Tuple[float, float, float]] = []
    right_top: List[Tuple[float, float, float]] = []

    for i in range(pts_count):
        # Tangent vector from neighbors
        if i == 0:
            dx = base_polyline[1][0] - base_polyline[0][0]
            dy = base_polyline[1][1] - base_polyline[0][1]
        elif i == pts_count - 1:
            dx = base_polyline[-1][0] - base_polyline[-2][0]
            dy = base_polyline[-1][1] - base_polyline[-2][1]
        else:
            dx = base_polyline[i + 1][0] - base_polyline[i - 1][0]
            dy = base_polyline[i + 1][1] - base_polyline[i - 1][1]

        seg_len = math.hypot(dx, dy)
        if seg_len < 1e-6:
            nx, ny = 0.0, 1.0
        else:
            nx = -dy / seg_len
            ny = dx / seg_len

        bx, by, bz = base_polyline[i]
        tx, ty, tz = top_polyline[i]

        left_base.append((bx + nx * half_t, by + ny * half_t, bz))
        right_base.append((bx - nx * half_t, by - ny * half_t, bz))
        left_top.append((tx + nx * half_t, ty + ny * half_t, tz))
        right_top.append((tx - nx * half_t, ty - ny * half_t, tz))

    # Assemble unified vertex array
    # 0 .. K-1: left_base
    # K .. 2K-1: right_base
    # 2K .. 3K-1: left_top
    # 3K .. 4K-1: right_top
    K = pts_count
    verts: List[Tuple[float, float, float]] = []
    verts.extend(left_base)
    verts.extend(right_base)
    verts.extend(left_top)
    verts.extend(right_top)

    faces: List[Tuple[int, int, int]] = []

    # Segments connecting index i to i+1
    for i in range(K - 1):
        lb0, lb1 = i, i + 1
        rb0, rb1 = K + i, K + i + 1
        lt0, lt1 = 2 * K + i, 2 * K + i + 1
        rt0, rt1 = 3 * K + i, 3 * K + i + 1

        # Left vertical face
        faces.append((lb0, lt0, lt1))
        faces.append((lb0, lt1, lb1))

        # Right vertical face
        faces.append((rb0, rb1, rt1))
        faces.append((rb0, rt1, rt0))

        # Top surface cap
        faces.append((lt0, rt0, rt1))
        faces.append((lt0, rt1, lt1))

        # Bottom foundation surface
        faces.append((lb0, lb1, rb1))
        faces.append((lb0, rb1, rb0))

    # Start endcap (at i=0)
    lb_s, rb_s, lt_s, rt_s = 0, K, 2 * K, 3 * K
    faces.append((lb_s, rb_s, rt_s))
    faces.append((lb_s, rt_s, lt_s))

    # Finish endcap (at i=K-1)
    lb_e, rb_e, lt_e, rt_e = K - 1, 2 * K - 1, 3 * K - 1, 4 * K - 1
    faces.append((lb_e, lt_e, rt_e))
    faces.append((lb_e, rt_e, rb_e))

    return {
        "vertices": verts,
        "faces": faces,
    }


def _generate_pipe_cylinder_mesh(
    p1: Tuple[float, float, float],
    p2: Tuple[float, float, float],
    radius: float = 0.15,
    radial_segments: int = 10,
) -> Dict[str, Any]:
    """Generate 3D cylindrical pipe solid along 3D vector from p1 to p2."""
    x1, y1, z1 = p1
    x2, y2, z2 = p2
    dx, dy, dz = x2 - x1, y2 - y1, z2 - z1
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    if length < 1e-5:
        return {"vertices": [], "faces": []}

    # Unit axis vector
    ax, ay, az = dx / length, dy / length, dz / length

    # Arbitrary perpendicular vector u
    if abs(ax) < 0.9:
        ux, uy, uz = 1.0, 0.0, 0.0
    else:
        ux, uy, uz = 0.0, 1.0, 0.0

    # Cross product axis x u -> v
    vx = ay * uz - az * uy
    vy = az * ux - ax * uz
    vz = ax * uy - ay * ux
    v_len = math.sqrt(vx * vx + vy * vy + vz * vz)
    vx, vy, vz = vx / v_len, vy / v_len, vz / v_len

    # True perpendicular u = v x axis
    ux = vy * az - vz * ay
    uy = vz * ax - vx * az
    uz = vx * ay - vy * ax

    r = max(0.02, float(radius))
    verts: List[Tuple[float, float, float]] = []
    faces: List[Tuple[int, int, int]] = []

    # Start ring (0 .. N-1)
    for i in range(radial_segments):
        ang = 2.0 * math.pi * float(i) / float(radial_segments)
        ca = math.cos(ang) * r
        sa = math.sin(ang) * r
        verts.append((x1 + ux * ca + vx * sa, y1 + uy * ca + vy * sa, z1 + uz * ca + vz * sa))

    # End ring (N .. 2N-1)
    for i in range(radial_segments):
        ang = 2.0 * math.pi * float(i) / float(radial_segments)
        ca = math.cos(ang) * r
        sa = math.sin(ang) * r
        verts.append((x2 + ux * ca + vx * sa, y2 + uy * ca + vy * sa, z2 + uz * ca + vz * sa))

    # Center caps
    c1_idx = len(verts)
    verts.append((x1, y1, z1))
    c2_idx = len(verts)
    verts.append((x2, y2, z2))

    # Sides (oppose caps for manifold edges and outward CCW normals)
    for i in range(radial_segments):
        nxt = (i + 1) % radial_segments
        b0 = i
        b1 = nxt
        t0 = i + radial_segments
        t1 = nxt + radial_segments
        faces.append((b0, b1, t1))
        faces.append((b0, t1, t0))

    # Caps
    for i in range(radial_segments):
        nxt = (i + 1) % radial_segments
        faces.append((c1_idx, nxt, i))
        faces.append((c2_idx, i + radial_segments, nxt + radial_segments))

    return {
        "vertices": verts,
        "faces": faces,
    }


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        f = float(val)
        return f if math.isfinite(f) else default
    except (ValueError, TypeError):
        return default


def _safe_coord_list(raw: Any, min_len: int = 2) -> List[Tuple[float, float, float]]:
    if not isinstance(raw, (list, tuple)):
        return []
    res: List[Tuple[float, float, float]] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        try:
            x = float(item[0])
            y = float(item[1])
            z = float(item[2]) if len(item) > 2 else 0.0
            if math.isfinite(x) and math.isfinite(y) and math.isfinite(z):
                res.append((x, y, z))
        except (ValueError, TypeError):
            continue
    return res if len(res) >= min_len else []


def _safe_coord_point(raw: Any, default: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Tuple[float, float, float]:
    if not isinstance(raw, (list, tuple)) or len(raw) < 2:
        return default
    try:
        x = float(raw[0])
        y = float(raw[1])
        z = float(raw[2]) if len(raw) > 2 else default[2]
        if math.isfinite(x) and math.isfinite(y) and math.isfinite(z):
            return (x, y, z)
    except (ValueError, TypeError):
        pass
    return default


# ---------------------------------------------------------------------------
# ScanToBimMixin Implementation
# ---------------------------------------------------------------------------
class ScanToBimMixin:
    """
    Civil Surveying Scan-to-BIM Mixin.
    Provides classified geometric primitive fitting and pure Python stdlib exporters (IFC, DXF, OBJ/MTL).
    """

    def fit_scan_to_bim_primitives(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Fit simplified geometric solids (parametric primitives) to classified scan features.
        Accepts user-configurable tolerances and categories (project-agnostic).
        """
        scan_id = str(payload.get("scan_id") or "").strip()
        if not scan_id:
            return {"ok": False, "status": "error", "error": "Missing scan_id"}

        categories = payload.get("categories")
        if not isinstance(categories, list) or not categories:
            categories = ["buildings", "walls", "roads", "trees", "water", "pipes"]
        active_cats = set(str(c).lower().strip() for c in categories)

        tolerance_m = max(0.05, float(payload.get("tolerance_m") or 0.25))
        wall_thickness_m = max(0.10, float(payload.get("wall_thickness_m") or 0.25))
        pipe_dia_m = max(0.05, float(payload.get("pipe_default_dia_m") or 0.30))
        min_wall_len = max(0.5, float(payload.get("min_wall_length_m") or 1.0))
        min_tree_h = max(0.5, float(payload.get("min_tree_height_m") or 1.5))

        # Retrieve categorization
        cat_data = payload.get("categorization_data") or payload.get("classified_objects")
        if not isinstance(cat_data, dict):
            cat_data = getattr(self, "get_saved_categorization", lambda s: None)(scan_id)
        if not isinstance(cat_data, dict) or not cat_data.get("ok"):
            cat_data = getattr(self, "categorize_scan_surfaces_and_objects", lambda p: {})(
                {"scan_id": scan_id, "cached_only": True}
            )

        if not isinstance(cat_data, dict) or not cat_data.get("ok"):
            # Provide graceful analytical fallback if scan has not been categorized yet
            cat_data = {
                "ok": True,
                "roads": [],
                "trees": [],
                "walls": [],
                "water_bodies": [],
                "anchor_twd97": {"e": 300000.0, "n": 2770000.0, "h": 20.0},
                "crs": TWD97_TWVD2001_LABEL,
            }

        anchor = cat_data.get("anchor_twd97") or {"e": 0.0, "n": 0.0, "h": 0.0}
        anc_e = float(anchor.get("e") or 0.0)
        anc_n = float(anchor.get("n") or 0.0)
        anc_h = float(anchor.get("h") or 0.0)

        def _to_studio_local(pt: Tuple[float, float, float]) -> Tuple[float, float, float]:
            """Convert (E, N, H) to Three.js studio coordinates (x = dE, y = dH, z = -dN)."""
            return (pt[0] - anc_e, pt[2] - anc_h, anc_n - pt[1])

        primitives: List[Dict[str, Any]] = []

        # -------------------------------------------------------------------
        # 1. WALLS -> 3D Extruded Wall Prisms
        # -------------------------------------------------------------------
        if "walls" in active_cats:
            walls_list = cat_data.get("walls") or []
            for w in walls_list:
                w_id = str(w.get("id") or "WL")
                length_m = float(w.get("length_m") or 0.0)
                if length_m < min_wall_len:
                    continue

                b_poly = w.get("base_polyline_twd97") or []
                t_poly = w.get("top_polyline_twd97") or []
                mean_h = float(w.get("mean_height_m") or w.get("height_m") or 2.0)
                azimuth = float(w.get("azimuth_deg") or 0.0)
                c_twd = w.get("center_twd97") or [anc_e, anc_n, anc_h]

                mesh_data: Dict[str, Any] = {"vertices": [], "faces": []}
                if len(b_poly) >= 2 and len(t_poly) >= 2:
                    mesh_data = _generate_extruded_wall_prism_mesh(
                        [tuple(p) for p in b_poly],
                        [tuple(p) for p in t_poly],
                        thickness_m=wall_thickness_m,
                    )
                else:
                    # Bounding prism fallback
                    mesh_data = _generate_box_mesh(
                        (c_twd[0], c_twd[1], c_twd[2]),
                        dx=length_m,
                        dy=wall_thickness_m,
                        dz=mean_h,
                        azimuth_deg=azimuth,
                    )

                v_twd = [list(v) for v in mesh_data["vertices"]]
                v_loc = [_to_studio_local(tuple(v)) for v in mesh_data["vertices"]]
                vol_m3 = round(length_m * mean_h * wall_thickness_m, 2)

                primitives.append({
                    "id": f"BIM_{w_id}",
                    "source_id": w_id,
                    "category": "walls",
                    "ifc_class": "IfcWall",
                    "name": f"Wall {w_id}",
                    "primitive_type": "extruded_prism",
                    "color": "#f43f5e",
                    "properties": {
                        "length_m": round(length_m, 2),
                        "height_m": round(mean_h, 2),
                        "thickness_m": round(wall_thickness_m, 2),
                        "azimuth_deg": round(azimuth, 1),
                        "vertical_area_m2": round(float(w.get("vertical_area_m2") or (length_m * mean_h)), 2),
                        "volume_m3": vol_m3,
                    },
                    "transform": {
                        "center_twd97": [round(c, 3) for c in c_twd],
                        "center_local": [round(c, 3) for c in _to_studio_local(tuple(c_twd))],
                    },
                    "mesh": {
                        "vertices_twd97": v_twd,
                        "vertices_local": v_loc,
                        "faces": mesh_data["faces"],
                    },
                })

        # -------------------------------------------------------------------
        # 2. TREES -> Trunk Cylinder + Canopy Ellipsoid
        # -------------------------------------------------------------------
        if "trees" in active_cats:
            trees_list = cat_data.get("trees") or []
            for t in trees_list:
                t_id = str(t.get("id") or "T")
                height_m = float(t.get("height_m") or 0.0)
                if height_m < min_tree_h:
                    continue

                dbh_cm = float(t.get("dbh_cm") or 20.0)
                trunk_r = max(0.06, (dbh_cm / 100.0) * 0.5)
                crown_d = float(t.get("crown_diameter_m") or (height_m * 0.55))
                crown_r = max(0.5, crown_d * 0.5)

                tr_twd = t.get("trunk_twd97") or [anc_e, anc_n, anc_h]
                ground_z = float(t.get("ground_elevation_m") or tr_twd[2])
                trunk_h = max(1.3, min(2.5, height_m * 0.35))

                # Trunk cylinder mesh
                trunk_mesh = _generate_cylinder_mesh(
                    (tr_twd[0], tr_twd[1], ground_z),
                    radius=trunk_r,
                    height=trunk_h,
                    radial_segments=12,
                )

                # Canopy ellipsoid mesh
                canopy_center_z = ground_z + trunk_h + (height_m - trunk_h) * 0.5
                canopy_rz = max(0.6, (height_m - trunk_h) * 0.55)
                canopy_mesh = _generate_ellipsoid_mesh(
                    (tr_twd[0], tr_twd[1], canopy_center_z),
                    rx=crown_r,
                    ry=crown_r,
                    rz=canopy_rz,
                    lat_segs=8,
                    lon_segs=12,
                )

                # Merge trunk + canopy into composite tree primitive mesh
                comb_verts_twd: List[Tuple[float, float, float]] = []
                comb_faces: List[Tuple[int, int, int]] = []

                comb_verts_twd.extend(trunk_mesh["vertices"])
                comb_faces.extend(trunk_mesh["faces"])

                c_offset = len(comb_verts_twd)
                comb_verts_twd.extend(canopy_mesh["vertices"])
                for a, b, c in canopy_mesh["faces"]:
                    comb_faces.append((a + c_offset, b + c_offset, c + c_offset))

                v_twd = [list(v) for v in comb_verts_twd]
                v_loc = [_to_studio_local(tuple(v)) for v in comb_verts_twd]
                trunk_vol = math.pi * trunk_r * trunk_r * trunk_h
                canopy_vol = (4.0 / 3.0) * math.pi * crown_r * crown_r * canopy_rz
                tot_vol = round(trunk_vol + canopy_vol, 2)

                primitives.append({
                    "id": f"BIM_{t_id}",
                    "source_id": t_id,
                    "category": "trees",
                    "ifc_class": "IfcGeographicElement",
                    "ifc_predefined_type": "USERDEFINED",
                    "ifc_object_type": "TREE",
                    "name": f"Tree {t_id}",
                    "primitive_type": "composite_tree",
                    "color": "#10b981",
                    "properties": {
                        "height_m": round(height_m, 2),
                        "dbh_cm": round(dbh_cm, 1),
                        "trunk_radius_m": round(trunk_r, 3),
                        "trunk_height_m": round(trunk_h, 2),
                        "crown_diameter_m": round(crown_d, 2),
                        "crown_area_m2": round(math.pi * crown_r * crown_r, 2),
                        "volume_m3": tot_vol,
                    },
                    "transform": {
                        "center_twd97": [round(tr_twd[0], 3), round(tr_twd[1], 3), round(ground_z, 3)],
                        "center_local": [round(c, 3) for c in _to_studio_local((tr_twd[0], tr_twd[1], ground_z))],
                    },
                    "mesh": {
                        "vertices_twd97": v_twd,
                        "vertices_local": v_loc,
                        "faces": comb_faces,
                    },
                })

        # -------------------------------------------------------------------
        # 3. ROADS -> 3D Surface Pavement Prisms
        # -------------------------------------------------------------------
        if "roads" in active_cats:
            roads_list = cat_data.get("roads") or []
            for r in roads_list:
                r_id = str(r.get("id") or "R")
                b_poly = r.get("boundary_twd97") or []
                if len(b_poly) < 3:
                    continue

                pavement_thick_m = 0.20
                c_twd = r.get("center_twd97") or [anc_e, anc_n, anc_h]
                mesh_data = _generate_extruded_polygon_mesh(
                    [tuple(p) for p in b_poly],
                    extrusion_depth=pavement_thick_m,
                    extrude_direction="down",
                )

                if not mesh_data["faces"]:
                    continue

                v_twd = [list(v) for v in mesh_data["vertices"]]
                v_loc = [_to_studio_local(tuple(v)) for v in mesh_data["vertices"]]
                p_area = float(r.get("planar_area_m2") or 0.0)
                vol_m3 = round(p_area * pavement_thick_m, 2)

                primitives.append({
                    "id": f"BIM_{r_id}",
                    "source_id": r_id,
                    "category": "roads",
                    "ifc_class": "IfcCivilElement",
                    "ifc_predefined_type": "USERDEFINED",
                    "ifc_object_type": "ROAD_PAVEMENT",
                    "name": f"Road {r_id}",
                    "primitive_type": "extruded_ribbon",
                    "color": "#f59e0b",
                    "properties": {
                        "planar_area_m2": round(p_area, 2),
                        "mean_width_m": round(float(r.get("mean_width_m") or 0.0), 2),
                        "mean_slope_pct": round(float(r.get("mean_slope_pct") or 0.0), 1),
                        "thickness_m": pavement_thick_m,
                        "volume_m3": vol_m3,
                    },
                    "transform": {
                        "center_twd97": [round(c, 3) for c in c_twd],
                        "center_local": [round(c, 3) for c in _to_studio_local(tuple(c_twd))],
                    },
                    "mesh": {
                        "vertices_twd97": v_twd,
                        "vertices_local": v_loc,
                        "faces": mesh_data["faces"],
                    },
                })

        # -------------------------------------------------------------------
        # 4. WATER BODIES -> Hydrostatic Bathymetric Prisms
        # -------------------------------------------------------------------
        if "water" in active_cats:
            water_list = cat_data.get("water_bodies") or []
            for wb in water_list:
                wb_id = str(wb.get("id") or "W")
                b_poly = wb.get("boundary_twd97") or []
                if len(b_poly) < 3:
                    continue

                w_level = float(wb.get("water_level_twvd2001_m") or (wb.get("center_twd97") or [0, 0, 0])[2])
                c_twd = wb.get("center_twd97") or [anc_e, anc_n, w_level]
                # Force flat water surface
                b_flat = [(p[0], p[1], w_level) for p in b_poly]
                depth_m = 0.80

                mesh_data = _generate_extruded_polygon_mesh(
                    b_flat,
                    extrusion_depth=depth_m,
                    extrude_direction="down",
                )
                if not mesh_data["faces"]:
                    continue

                v_twd = [list(v) for v in mesh_data["vertices"]]
                v_loc = [_to_studio_local(tuple(v)) for v in mesh_data["vertices"]]
                p_area = float(wb.get("planar_area_m2") or 0.0)
                vol_m3 = round(p_area * depth_m, 2)

                primitives.append({
                    "id": f"BIM_{wb_id}",
                    "source_id": wb_id,
                    "category": "water",
                    "ifc_class": "IfcGeographicElement",
                    "ifc_predefined_type": "USERDEFINED",
                    "ifc_object_type": "WATER_BODY",
                    "name": f"Water {wb_id}",
                    "primitive_type": "water_prism",
                    "color": "#06b6d4",
                    "properties": {
                        "water_level_m": round(w_level, 2),
                        "planar_area_m2": round(p_area, 2),
                        "perimeter_m": round(float(wb.get("perimeter_m") or 0.0), 1),
                        "depth_m": depth_m,
                        "volume_m3": vol_m3,
                    },
                    "transform": {
                        "center_twd97": [round(c_twd[0], 3), round(c_twd[1], 3), round(w_level, 3)],
                        "center_local": [round(c, 3) for c in _to_studio_local((c_twd[0], c_twd[1], w_level))],
                    },
                    "mesh": {
                        "vertices_twd97": v_twd,
                        "vertices_local": v_loc,
                        "faces": mesh_data["faces"],
                    },
                })

        # -------------------------------------------------------------------
        # 5. BUILDINGS & STRUCTURES -> 3D Bounding Prisms
        # -------------------------------------------------------------------
        if "buildings" in active_cats:
            # Check for buildings in categorization or manual overrides
            bldg_entries = cat_data.get("buildings_structures") or cat_data.get("buildings") or []
            if not bldg_entries:
                # Check breakdown key
                for item in cat_data.get("categories_breakdown") or []:
                    if item.get("key") == "buildings_structures" and item.get("count", 0) > 0:
                        # Synthetic structure block from site bounds or walls
                        p_area = float(item.get("planar_area_m2") or 150.0)
                        dim = math.sqrt(max(25.0, p_area))
                        bldg_entries = [{
                            "id": "B1",
                            "name": "Building B1",
                            "center_twd97": [anc_e + 15.0, anc_n + 15.0, anc_h + 3.0],
                            "dx": round(dim, 2),
                            "dy": round(dim * 0.8, 2),
                            "height_m": 6.5,
                            "footprint_area_m2": round(p_area, 2),
                        }]
                        break

            for b in bldg_entries:
                b_id = str(b.get("id") or "B1")
                c_twd = b.get("center_twd97") or [anc_e, anc_n, anc_h + 2.5]
                dx = float(b.get("dx") or 12.0)
                dy = float(b.get("dy") or 8.0)
                h = float(b.get("height_m") or 6.0)
                az = float(b.get("azimuth_deg") or 0.0)

                mesh_data = _generate_box_mesh(
                    (c_twd[0], c_twd[1], c_twd[2]),
                    dx=dx,
                    dy=dy,
                    dz=h,
                    azimuth_deg=az,
                )

                v_twd = [list(v) for v in mesh_data["vertices"]]
                v_loc = [_to_studio_local(tuple(v)) for v in mesh_data["vertices"]]
                vol_m3 = round(dx * dy * h, 2)

                primitives.append({
                    "id": f"BIM_{b_id}",
                    "source_id": b_id,
                    "category": "buildings",
                    "ifc_class": "IfcBuildingElementProxy",
                    "ifc_predefined_type": "USERDEFINED",
                    "ifc_object_type": "BUILDING",
                    "name": f"Structure {b_id}",
                    "primitive_type": "cuboid",
                    "color": "#3b82f6",
                    "properties": {
                        "length_m": round(dx, 2),
                        "width_m": round(dy, 2),
                        "height_m": round(h, 2),
                        "footprint_area_m2": round(dx * dy, 2),
                        "volume_m3": vol_m3,
                    },
                    "transform": {
                        "center_twd97": [round(c, 3) for c in c_twd],
                        "center_local": [round(c, 3) for c in _to_studio_local(tuple(c_twd))],
                    },
                    "mesh": {
                        "vertices_twd97": v_twd,
                        "vertices_local": v_loc,
                        "faces": mesh_data["faces"],
                    },
                })

        # -------------------------------------------------------------------
        # 6. PIPES & UTILITIES -> 3D Cylindrical Solids
        # -------------------------------------------------------------------
        if "pipes" in active_cats:
            pipes_list = cat_data.get("pipes") or payload.get("pipes") or []
            if not pipes_list and payload.get("include_sample_pipe"):
                # Optional sample utility run for testing & verification
                pipes_list = [{
                    "id": "P1",
                    "start": [anc_e - 10.0, anc_n - 10.0, anc_h - 1.2],
                    "end": [anc_e + 20.0, anc_n - 10.0, anc_h - 1.5],
                    "diameter_m": pipe_dia_m,
                    "utility_type": "Storm Sewer",
                }]

            for p in pipes_list:
                p_id = str(p.get("id") or "P1")
                p_start = p.get("start") or [anc_e, anc_n, anc_h - 1.0]
                p_end = p.get("end") or [anc_e + 10.0, anc_n, anc_h - 1.2]
                dia = float(p.get("diameter_m") or pipe_dia_m)
                r_pipe = dia * 0.5

                mesh_data = _generate_pipe_cylinder_mesh(
                    tuple(p_start), tuple(p_end), radius=r_pipe, radial_segments=10
                )
                if not mesh_data["faces"]:
                    continue

                dx = p_end[0] - p_start[0]
                dy = p_end[1] - p_start[1]
                dz = p_end[2] - p_start[2]
                length_m = math.sqrt(dx * dx + dy * dy + dz * dz)
                c_pt = (
                    (p_start[0] + p_end[0]) * 0.5,
                    (p_start[1] + p_end[1]) * 0.5,
                    (p_start[2] + p_end[2]) * 0.5,
                )

                v_twd = [list(v) for v in mesh_data["vertices"]]
                v_loc = [_to_studio_local(tuple(v)) for v in mesh_data["vertices"]]
                vol_m3 = round(math.pi * r_pipe * r_pipe * length_m, 3)

                primitives.append({
                    "id": f"BIM_{p_id}",
                    "source_id": p_id,
                    "category": "pipes",
                    "ifc_class": "IfcFlowSegment",
                    "ifc_predefined_type": "USERDEFINED",
                    "ifc_object_type": "PIPE",
                    "name": f"Pipe {p_id}",
                    "primitive_type": "pipe_cylinder",
                    "color": "#f97316",
                    "properties": {
                        "length_m": round(length_m, 2),
                        "diameter_mm": int(dia * 1000.0),
                        "slope_pct": round(abs(dz / max(1e-4, math.hypot(dx, dy))) * 100.0, 2),
                        "invert_start_m": round(p_start[2], 3),
                        "invert_end_m": round(p_end[2], 3),
                        "volume_m3": vol_m3,
                    },
                    "transform": {
                        "center_twd97": [round(c, 3) for c in c_pt],
                        "center_local": [round(c, 3) for c in _to_studio_local(c_pt)],
                    },
                    "mesh": {
                        "vertices_twd97": v_twd,
                        "vertices_local": v_loc,
                        "faces": mesh_data["faces"],
                    },
                })

        # Summary KPIs
        cat_counts: Dict[str, int] = {}
        cat_vols: Dict[str, float] = {}
        total_vol = 0.0

        for prim in primitives:
            c_key = prim["category"]
            cat_counts[c_key] = cat_counts.get(c_key, 0) + 1
            v = float(prim.get("properties", {}).get("volume_m3") or 0.0)
            cat_vols[c_key] = round(cat_vols.get(c_key, 0.0) + v, 2)
            total_vol += v

        # Trigger auto-export if requested
        export_formats = payload.get("export_formats") or []
        downloads: Dict[str, str] = {}
        if export_formats:
            exp_res = self.export_scan_to_bim({
                "scan_id": scan_id,
                "formats": export_formats,
                "primitives": primitives,
            })
            downloads = exp_res.get("downloads") or {}

        return {
            "ok": True,
            "status": "ok",
            "scan_id": scan_id,
            "crs": TWD97_TWVD2001_LABEL,
            "crs_short": TWD97_TWVD2001_SHORT,
            "anchor_twd97": anchor,
            "primitive_count": len(primitives),
            "total_volume_m3": round(total_vol, 2),
            "categories_summary": {
                c: {"count": cat_counts.get(c, 0), "volume_m3": cat_vols.get(c, 0.0)}
                for c in ["buildings", "walls", "roads", "trees", "water", "pipes"]
            },
            "primitives": primitives,
            "downloads": downloads,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    def export_scan_to_bim(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Pure Python Standard Library Exporter for Scan-to-BIM primitives:
        1. ISO-10303-21 IFC SPF (schema IFC4)
        2. AutoCAD 3D DXF (ASCII format with 3DFACE solids)
        3. Wavefront OBJ + MTL (Semantic grouped meshes)
        """
        scan_id = str(payload.get("scan_id") or "scan").strip()
        primitives = payload.get("primitives")
        if not isinstance(primitives, list):
            fit_res = self.fit_scan_to_bim_primitives(payload)
            primitives = fit_res.get("primitives") or []

        formats_requested = payload.get("formats") or payload.get("format") or ["ifc", "dxf", "obj"]
        if isinstance(formats_requested, str):
            formats_requested = [formats_requested]
        req_set = set(str(f).lower().strip() for f in formats_requested)
        if "all" in req_set:
            req_set = {"ifc", "dxf", "obj"}

        os.makedirs(REPORTS_DIR, exist_ok=True)
        os.makedirs(CONTOURS_DIR, exist_ok=True)

        base_fname = f"scan_{scan_id}_bim"
        downloads: Dict[str, str] = {}
        written_files: List[str] = []

        # -------------------------------------------------------------------
        # 1. IFC SPF Exporter (Pure Python Standard Library, ISO-10303-21 IFC4)
        # -------------------------------------------------------------------
        if "ifc" in req_set:
            ifc_name = f"{base_fname}.ifc"
            ifc_path = os.path.join(REPORTS_DIR, ifc_name)
            ifc_content = self._generate_pure_python_ifc_spf(scan_id, primitives)
            with open(ifc_path, "w", encoding="utf-8") as f:
                f.write(ifc_content)
            downloads["ifc_url"] = f"/api/reports/{ifc_name}"
            written_files.append(ifc_path)

        # -------------------------------------------------------------------
        # 2. AutoCAD 3D DXF Exporter (Pure Python Standard Library, 3DFACE)
        # -------------------------------------------------------------------
        if "dxf" in req_set:
            dxf_name = f"{base_fname}_3d.dxf"
            dxf_path = os.path.join(REPORTS_DIR, dxf_name)
            dxf_content = self._generate_pure_python_3d_dxf(scan_id, primitives)
            with open(dxf_path, "w", encoding="utf-8") as f:
                f.write(dxf_content)
            # Also mirror to CONTOURS_DIR for canonical dual-path download
            contour_dxf = os.path.join(CONTOURS_DIR, dxf_name)
            try:
                with open(contour_dxf, "w", encoding="utf-8") as f:
                    f.write(dxf_content)
            except Exception:
                pass
            downloads["dxf_url"] = f"/api/reports/{dxf_name}"
            written_files.append(dxf_path)

        # -------------------------------------------------------------------
        # 3. Wavefront OBJ + MTL Exporter (Pure Python Standard Library)
        # -------------------------------------------------------------------
        if "obj" in req_set:
            obj_name = f"{base_fname}.obj"
            mtl_name = f"{base_fname}.mtl"
            obj_path = os.path.join(REPORTS_DIR, obj_name)
            mtl_path = os.path.join(REPORTS_DIR, mtl_name)

            obj_str, mtl_str = self._generate_pure_python_obj_mtl(scan_id, primitives, mtl_name)
            with open(obj_path, "w", encoding="utf-8") as f:
                f.write(obj_str)
            with open(mtl_path, "w", encoding="utf-8") as f:
                f.write(mtl_str)

            downloads["obj_url"] = f"/api/reports/{obj_name}"
            downloads["mtl_url"] = f"/api/reports/{mtl_name}"
            written_files.extend([obj_path, mtl_path])

        return {
            "ok": True,
            "status": "ok",
            "scan_id": scan_id,
            "primitive_count": len(primitives),
            "written_files": written_files,
            "downloads": downloads,
        }

    # -----------------------------------------------------------------------
    # Exporter Internal Pure-Python Generators
    # -----------------------------------------------------------------------
    def _generate_pure_python_ifc_spf(self, scan_id: str, primitives: List[Dict[str, Any]]) -> str:
        """
        Produce genuine ISO-10303-21 IFC SPF exchange file with schema IFC4.
        Constructs:
        - Header section with schema IFC4
        - Project / Site / Building / Storey spatial decomposition
        - IfcGeometricRepresentationContext & IfcAxis2Placement3D
        - IfcSurfaceStyleShading colors for each element category
        - IfcProductDefinitionShape with IfcShapeRepresentation (Brep)
        - IfcFacetedBrep with IfcClosedShell & IfcPolyLoop faces
        - IfcRelContainedInSpatialStructure linking all products to Ground Storey
        """
        lines: List[str] = []
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

        # STEP File Header
        lines.append("ISO-10303-21;")
        lines.append("HEADER;")
        lines.append("FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');")
        lines.append(
            f"FILE_NAME('{scan_id}_BIM_Model.ifc','{now_str}',('GatheringScans Civil BIM Exporter'),"
            f"('Gatheren Cloud Engineering'),'GatheringScans Python IFC Generator','GatheringScans 2026.10','Civil Surveying & BIM');"
        )
        lines.append("FILE_SCHEMA(('IFC4'));")
        lines.append("ENDSEC;")
        lines.append("DATA;")

        # Entity Counter
        eid = 1

        def next_id() -> int:
            nonlocal eid
            cur = eid
            eid += 1
            return cur

        # Basic metadata & units
        id_owner = next_id()
        id_person_org = next_id()
        id_app = next_id()
        id_person = next_id()
        id_org = next_id()

        lines.append(f"#{id_person}=IFCPERSON($,'Surveyor','GatheringScans',$,$,$,$,$);")
        lines.append(f"#{id_org}=IFCORGANIZATION($,'Gatheren Cloud Engineering',$,$,$);")
        lines.append(f"#{id_person_org}=IFCPERSONANDORGANIZATION(#{id_person},#{id_org},$);")
        lines.append(f"#{id_app}=IFCAPPLICATION(#{id_org},'2026.10','GatheringScans','GS-BIM');")
        lines.append(f"#{id_owner}=IFCOWNERHISTORY(#{id_person_org},#{id_app},$,.ADDED.,1730361600,$,$,1730361600);")

        # SI Units
        id_u_len = next_id()
        id_u_area = next_id()
        id_u_vol = next_id()
        id_u_assign = next_id()
        lines.append(f"#{id_u_len}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);")
        lines.append(f"#{id_u_area}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);")
        lines.append(f"#{id_u_vol}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);")
        lines.append(f"#{id_u_assign}=IFCUNITASSIGNMENT((#{id_u_len},#{id_u_area},#{id_u_vol}));")

        # Geometric Context & Global Placement
        id_origin = next_id()
        id_dir_z = next_id()
        id_dir_x = next_id()
        id_axis = next_id()
        id_dir_plan = next_id()
        id_context = next_id()

        lines.append(f"#{id_origin}=IFCCARTESIANPOINT((0.,0.,0.));")
        lines.append(f"#{id_dir_z}=IFCDIRECTION((0.,0.,1.));")
        lines.append(f"#{id_dir_x}=IFCDIRECTION((1.,0.,0.));")
        lines.append(f"#{id_axis}=IFCAXIS2PLACEMENT3D(#{id_origin},#{id_dir_z},#{id_dir_x});")
        lines.append(f"#{id_dir_plan}=IFCDIRECTION((0.,1.));")
        lines.append(f"#{id_context}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#{id_axis},#{id_dir_plan});")

        # Spatial Structure: Project -> Site -> Building -> Storey
        id_proj = next_id()
        id_site = next_id()
        id_bldg = next_id()
        id_storey = next_id()

        lines.append(f"#{id_proj}=IFCPROJECT('{create_ifc_guid()}',#{id_owner},'GatheringScans Civil Scan-to-BIM Project',$,$,$,$,(#{id_context}),#{id_u_assign});")
        lines.append(f"#{id_site}=IFCSITE('{create_ifc_guid()}',#{id_owner},'Civil Survey Site',$,$,#{id_axis},$,$,.ELEMENT.,(25,2,0),(121,30,0),15.0,$,$);")
        lines.append(f"#{id_bldg}=IFCBUILDING('{create_ifc_guid()}',#{id_owner},'Site Elements',$,$,#{id_axis},$,$,.ELEMENT.,$,$,$);")
        lines.append(f"#{id_storey}=IFCBUILDINGSTOREY('{create_ifc_guid()}',#{id_owner},'Ground Level',$,$,#{id_axis},$,$,.ELEMENT.,0.0);")

        lines.append(f"#{next_id()}=IFCRELAGGREGATES('{create_ifc_guid()}',#{id_owner},$,$,#{id_proj},(#{id_site}));")
        lines.append(f"#{next_id()}=IFCRELAGGREGATES('{create_ifc_guid()}',#{id_owner},$,$,#{id_site},(#{id_bldg}));")
        lines.append(f"#{next_id()}=IFCRELAGGREGATES('{create_ifc_guid()}',#{id_owner},$,$,#{id_bldg},(#{id_storey}));")

        # Material styles per category
        color_map = {
            "walls": (0.82, 0.82, 0.84),
            "trees": (0.15, 0.72, 0.28),
            "roads": (0.28, 0.28, 0.32),
            "water": (0.12, 0.68, 0.88),
            "buildings": (0.38, 0.58, 0.82),
            "pipes": (0.92, 0.45, 0.15),
        }
        style_ids: Dict[str, int] = {}
        for cat, rgb in color_map.items():
            id_col = next_id()
            id_shading = next_id()
            id_surf_style = next_id()
            lines.append(f"#{id_col}=IFCCOLOURRGB($,{rgb[0]:.3f},{rgb[1]:.3f},{rgb[2]:.3f});")
            lines.append(f"#{id_shading}=IFCSURFACESTYLESHADING(#{id_col});")
            lines.append(f"#{id_surf_style}=IFCSURFACESTYLE('{cat.upper()}_STYLE',.BOTH.,(#{id_shading}));")
            style_ids[cat] = id_surf_style

        product_ids: List[int] = []

        # Write each BIM Primitive
        for prim in primitives:
            cat = prim.get("category") or "walls"
            mesh = prim.get("mesh") or {}
            verts = mesh.get("vertices_twd97") or []
            faces = mesh.get("faces") or []

            if not verts or not faces:
                continue

            # Create Cartesian Points for this mesh
            v_id_start = eid
            for vx, vy, vz in verts:
                cur_v_id = next_id()
                lines.append(f"#{cur_v_id}=IFCCARTESIANPOINT(({vx:.4f},{vy:.4f},{vz:.4f}));")

            # Create Polyloops & Face Outer Bounds
            face_ids: List[int] = []
            for a, b, c in faces:
                id_loop = next_id()
                lines.append(f"#{id_loop}=IFCPOLYLOOP((#{v_id_start + a},#{v_id_start + b},#{v_id_start + c}));")
                id_face_bound = next_id()
                lines.append(f"#{id_face_bound}=IFCFACEOUTERBOUND(#{id_loop},.T.);")
                id_face = next_id()
                lines.append(f"#{id_face}=IFCFACE((#{id_face_bound}));")
                face_ids.append(id_face)

            # Closed Shell & Faceted Brep
            id_shell = next_id()
            face_refs = ",".join(f"#{fid}" for fid in face_ids)
            lines.append(f"#{id_shell}=IFCCLOSEDSHELL(({face_refs}));")

            id_brep = next_id()
            lines.append(f"#{id_brep}=IFCFACETEDBREP(#{id_shell});")

            # Style association
            if cat in style_ids:
                id_styled = next_id()
                lines.append(f"#{id_styled}=IFCSTYLEDITEM(#{id_brep},(#{style_ids[cat]}),$);")

            # Shape Representation
            id_rep = next_id()
            lines.append(f"#{id_rep}=IFCSHAPEREPRESENTATION(#{id_context},'Body','Brep',(#{id_brep}));")

            id_prod_shape = next_id()
            lines.append(f"#{id_prod_shape}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{id_rep}));")

            # Semantic Product Entity
            prim_name = prim.get("name") or prim.get("id") or "BIM_Element"
            prim_id_str = prim.get("id") or "E1"
            ifc_cls = prim.get("ifc_class") or "IfcBuildingElementProxy"
            id_elem = next_id()

            if ifc_cls == "IfcWall":
                lines.append(f"#{id_elem}=IFCWALL('{create_ifc_guid()}',#{id_owner},'{prim_name}',$,$,#{id_axis},#{id_prod_shape},'{prim_id_str}');")
            elif ifc_cls == "IfcCivilElement":
                lines.append(f"#{id_elem}=IFCCIVILELEMENT('{create_ifc_guid()}',#{id_owner},'{prim_name}',$,$,#{id_axis},#{id_prod_shape},'{prim_id_str}');")
            elif ifc_cls == "IfcFlowSegment":
                lines.append(f"#{id_elem}=IFCFLOWSEGMENT('{create_ifc_guid()}',#{id_owner},'{prim_name}',$,$,#{id_axis},#{id_prod_shape},'{prim_id_str}');")
            elif ifc_cls == "IfcGeographicElement":
                lines.append(f"#{id_elem}=IFCGEOGRAPHIC_ELEMENT('{create_ifc_guid()}',#{id_owner},'{prim_name}',$,$,#{id_axis},#{id_prod_shape},'{prim_id_str}',.USERDEFINED.);")
            else:
                lines.append(f"#{id_elem}=IFCBUILDINGELEMENTPROXY('{create_ifc_guid()}',#{id_owner},'{prim_name}',$,$,#{id_axis},#{id_prod_shape},'{prim_id_str}',.USERDEFINED.);")

            product_ids.append(id_elem)

        # Containment relation linking all elements to Building Storey
        if product_ids:
            prod_refs = ",".join(f"#{pid}" for pid in product_ids)
            lines.append(f"#{next_id()}=IFCRELCONTAINEDINSPATIALSTRUCTURE('{create_ifc_guid()}',#{id_owner},'Site Elements Containment',$,({prod_refs}),#{id_storey});")

        lines.append("ENDSEC;")
        lines.append("END-ISO-10303-21;")

        return "\n".join(lines) + "\n"

    def _generate_pure_python_3d_dxf(self, scan_id: str, primitives: List[Dict[str, Any]]) -> str:
        """
        Produce genuine AutoCAD ASCII 3D DXF model (R12/2000 compatibility).
        Uses categorized 3DFACE entities with standard AutoCAD Color Index (ACI) layers.
        """
        lines: List[str] = []

        # DXF Header
        lines.extend([
            "0", "SECTION",
            "2", "HEADER",
            "9", "$ACADVER", "1", "AC1015",
            "9", "$INSUNITS", "70", "6",  # 6 = Meters
            "0", "ENDSEC",
        ])

        # DXF Tables & Layers
        layer_colors = {
            "BIM_WALLS": 1,        # Red
            "BIM_TREES": 3,        # Green
            "BIM_ROADS": 8,        # Dark Grey
            "BIM_WATER": 4,        # Cyan
            "BIM_BUILDINGS": 5,    # Blue
            "BIM_PIPES": 30,       # Orange
        }

        lines.extend([
            "0", "SECTION",
            "2", "TABLES",
            "0", "TABLE",
            "2", "LAYER",
            "70", str(len(layer_colors)),
        ])

        for l_name, l_color in layer_colors.items():
            lines.extend([
                "0", "LAYER",
                "2", l_name,
                "70", "0",
                "62", str(l_color),
                "6", "CONTINUOUS",
            ])

        lines.extend(["0", "ENDTAB", "0", "ENDSEC"])

        # DXF Entities Section
        lines.extend(["0", "SECTION", "2", "ENTITIES"])

        cat_layer_map = {
            "walls": "BIM_WALLS",
            "trees": "BIM_TREES",
            "roads": "BIM_ROADS",
            "water": "BIM_WATER",
            "buildings": "BIM_BUILDINGS",
            "pipes": "BIM_PIPES",
        }

        for prim in primitives:
            cat = prim.get("category") or "walls"
            layer = cat_layer_map.get(cat, "BIM_BUILDINGS")
            mesh = prim.get("mesh") or {}
            verts = mesh.get("vertices_twd97") or []
            faces = mesh.get("faces") or []

            for a, b, c in faces:
                p0 = verts[a]
                p1 = verts[b]
                p2 = verts[c]
                # In AutoCAD DXF 3DFACE, a triangle is represented by repeating vertex 3 as vertex 4
                lines.extend([
                    "0", "3DFACE",
                    "8", layer,
                    "10", f"{p0[0]:.4f}", "20", f"{p0[1]:.4f}", "30", f"{p0[2]:.4f}",
                    "11", f"{p1[0]:.4f}", "21", f"{p1[1]:.4f}", "31", f"{p1[2]:.4f}",
                    "12", f"{p2[0]:.4f}", "22", f"{p2[1]:.4f}", "32", f"{p2[2]:.4f}",
                    "13", f"{p2[0]:.4f}", "23", f"{p2[1]:.4f}", "33", f"{p2[2]:.4f}",
                ])

        lines.extend(["0", "ENDSEC", "0", "EOF"])
        return "\n".join(lines) + "\n"

    def _generate_pure_python_obj_mtl(
        self, scan_id: str, primitives: List[Dict[str, Any]], mtl_filename: str
    ) -> Tuple[str, str]:
        """
        Produce genuine Wavefront OBJ and accompanying MTL material definitions.
        Outputs grouped solid meshes by primitive ID and category.
        """
        obj_lines: List[str] = [
            f"# GatheringScans Scan-to-BIM Wavefront OBJ Export",
            f"# Scan ID: {scan_id}",
            f"# Generated: {datetime.now(timezone.utc).isoformat()}",
            f"mtllib {mtl_filename}",
            "",
        ]

        mtl_lines: List[str] = [
            "# GatheringScans Scan-to-BIM Material Library",
            "# Physically ground color & opacity definition per element class",
            "",
        ]

        materials = {
            "Mat_Wall": {"kd": "0.82 0.82 0.84", "d": "0.95"},
            "Mat_Tree": {"kd": "0.15 0.72 0.28", "d": "0.85"},
            "Mat_Road": {"kd": "0.28 0.28 0.32", "d": "1.0"},
            "Mat_Water": {"kd": "0.12 0.68 0.88", "d": "0.65"},
            "Mat_Building": {"kd": "0.38 0.58 0.82", "d": "0.90"},
            "Mat_Pipe": {"kd": "0.92 0.45 0.15", "d": "1.0"},
        }

        for m_name, m_props in materials.items():
            mtl_lines.extend([
                f"newmtl {m_name}",
                "Ka 0.2 0.2 0.2",
                f"Kd {m_props['kd']}",
                "Ks 0.1 0.1 0.1",
                f"d {m_props['d']}",
                "illum 2",
                "",
            ])

        cat_mat_map = {
            "walls": "Mat_Wall",
            "trees": "Mat_Tree",
            "roads": "Mat_Road",
            "water": "Mat_Water",
            "buildings": "Mat_Building",
            "pipes": "Mat_Pipe",
        }

        vertex_offset = 1  # OBJ vertices are 1-based

        for prim in primitives:
            cat = prim.get("category") or "walls"
            mat = cat_mat_map.get(cat, "Mat_Building")
            p_id = prim.get("id") or "Element"
            mesh = prim.get("mesh") or {}
            verts = mesh.get("vertices_twd97") or []
            faces = mesh.get("faces") or []

            if not verts or not faces:
                continue

            obj_lines.append(f"o {p_id}")
            obj_lines.append(f"g {cat.capitalize()}_{p_id}")
            obj_lines.append(f"usemtl {mat}")

            for vx, vy, vz in verts:
                obj_lines.append(f"v {vx:.4f} {vy:.4f} {vz:.4f}")

            for a, b, c in faces:
                obj_lines.append(f"f {vertex_offset + a} {vertex_offset + b} {vertex_offset + c}")

            vertex_offset += len(verts)
            obj_lines.append("")

        return "\n".join(obj_lines) + "\n", "\n".join(mtl_lines) + "\n"
