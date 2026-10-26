/**
 * GatheringScans — Full Traditional Chinese (zh-TW) & English (en) i18n Engine
 * Default UI language: "zh-TW" (Traditional Chinese)
 * Secondary UI language: "en" (English)
 * Strict Rule: Zero bilingual translations in brackets (e.g. never "English (中文)" or "中文 (English)").
 */
(function () {
  "use strict";

  var STORAGE_KEY = "gs_ui_language";
  var DEFAULT_LANG = "zh-TW";
  var currentLang = DEFAULT_LANG;

  function normalizeLanguageCode(raw) {
    if (!raw || typeof raw !== "string") return DEFAULT_LANG;
    var v = raw.trim().toLowerCase();
    if (v === "en" || v.indexOf("en-") === 0 || v === "english") return "en";
    if (v === "zh" || v.indexOf("zh-") === 0 || v === "cht" || v === "traditional chinese") return "zh-TW";
    return DEFAULT_LANG;
  }

  // Initialize from localStorage if valid, else check stored user profile before falling back to DEFAULT_LANG
  try {
    var stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh-TW") {
      currentLang = stored;
    } else {
      var profKeysInit = ["gathering_user_profile", "gs_current_user", "gs_user_profile_v1"];
      var foundProfLang = "";
      for (var pk = 0; pk < profKeysInit.length; pk++) {
        try {
          var rawP = localStorage.getItem(profKeysInit[pk]);
          if (rawP) {
            var parsedP = JSON.parse(rawP);
            if (parsedP && (parsedP.language === "en" || parsedP.language === "zh-TW")) {
              foundProfLang = parsedP.language;
              break;
            }
          }
        } catch (eProf) {}
      }
      currentLang = foundProfLang || DEFAULT_LANG;
    }
  } catch (e) {
    currentLang = DEFAULT_LANG;
  }

  function getAppLanguage() {
    return currentLang;
  }

  function tr(zhText, enText) {
    return currentLang === "en" ? enText : zhText;
  }

  /**
   * Bidirectional phrase pairs [zh-TW, en] for dynamic inspectors, modals, badges, and toasts.
   * Ordered from longest/most specific phrases to shorter tokens so replacements never clobber substrings.
   */
  var PHRASE_PAIRS = [
    // 1. Side Panel Titles (13 Studio tools + Manual Edit + Generate Scan)
    ["土方體積與挖填分析", "Cut/Fill & Stockpile Volume"],
    ["測量圖資報表 (Civil3D.dwg & A3 PDF)", "Survey Report (Civil3D.dwg & A3 PDF)"],
    ["斷面高程與坡度分析", "Cross-Section Profile"],
    ["RTK 相機空間照片檢視", "RTK Camera Inspector"],
    ["3D 剖面盒裁切器", "Section Box Slicer"],
    ["AI 自動地物分類", "AI Surface & Object Categorization"],
    ["3D 空間標註", "3D Geo-Comments"],
    ["套索標記刪除", "Lasso Delete — Mark & Delete"],
    ["框選保留範圍", "Crop Keep — Keep Selected Region"],
    ["多掃描 3D 對齊與合併", "Multi-Scan 3D Alignment & Merge"],
    ["網格與貼圖壓縮優化", "Mesh & Texture Compression"],
    ["座標系統與高程基準轉換", "Coordinate System & Datum"],
    ["儲存掃描變更", "Save Scan Edits"],
    ["✓ 變更已儲存 · 原掃描已備份至回收桶", "✓ Edits Saved · Backup in Trash Bin"],

    // 2. Volume / Cut-Fill Inspector
    [
      "步驟 1：在 3D 掃描模型上點擊 3 個以上頂點繪製挖填範圍。步驟 2：點擊紅色起點 V1（或按 Enter / 鎖定並計算）完成多邊形並計算土方。",
      "Step 1: Click 3+ points on the 3D scan to draw a Cut/Fill boundary polygon. Step 2: Click red start point V1 (or press Enter / Lock & Compute) to lock the polygon and calculate volume."
    ],
    ["在 3D 掃描模型上點擊 3 個以上頂點繪製挖填範圍", "Click 3+ points on the 3D scan to draw a Cut/Fill boundary polygon"],
    ["點擊紅色起點 V1（或按 Enter / 鎖定並計算）完成多邊形並計算土方", "Click red start point V1 (or press Enter / Lock & Compute) to lock the polygon and calculate volume"],
    ["土方或物料堆名稱", "Zone / Stockpile Name"],
    ["基準面計算方式", "Base Reference Surface Mode"],
    ["1. 獨立土石堆周界擬合面", "1. Triangulated Boundary Perimeter"],
    ["2. 指定設計高程基準面 Z₀ (TWVD2001)", "2. Custom Datum Elevation Plane Z₀ (TWVD2001)"],
    ["3. 跨期掃描進度挖填差額", "3. Multi-Date Epoch-to-Epoch Diff"],
    ["物料種類與比重 (t/m³)", "Material Classification & Bulk Density (t/m³)"],
    ["比重 (t/m³)", "Density (t/m³)"],
    ["基準高程 Z₀ (TWVD2001 m)", "Datum Elev Z₀ (TWVD2001 m)"],
    ["鎖定多邊形並計算挖填土方體積", "Lock Polygon & Compute Cut/Fill Volume"],
    ["鎖定並計算", "Lock & Compute"],
    ["清除並重新繪製範圍多邊形", "Clear & Draw New Boundary Polygon"],
    ["重新繪製多邊形", "Redraw Polygon"],
    ["尚未繪製範圍多邊形", "Awaiting Boundary Polygon"],
    [
      "請在 3D 掃描模型上的土石堆或開挖區周圍點擊至少 3 個頂點，接著點擊紅色起點 V1（或按 Enter）以鎖定多邊形並計算土方體積。",
      "Click at least 3 points around a stockpile or excavation zone on the 3D scan, then click the red start point V1 (or press Enter) to lock the polygon and calculate volume."
    ],
    ["挖填方起點 V1 (請點擊至少 3 點圍成範圍)", "Cut/Fill Start V1 (Click 3+ points)"],
    ["點此鎖定", "Click to Lock"],
    ["挖方體積", "Cut Volume"],
    ["填方體積", "Fill Volume"],
    ["淨土方量", "Net Volume"],
    ["投影面積", "Plan Area"],
    ["表面積", "Surface Area"],
    ["周長", "Perimeter"],
    ["挖方", "Cut"],
    ["填方", "Fill"],
    ["淨土方", "Net"],

    // 3. Contours / Survey Report Inspector
    ["圖名 / 掃描專案名稱", "Engineering Frame Title"],
    ["次等高線間距 (m)", "Minor Interval (m)"],
    ["計曲線間距 (m)", "Major Interval (m)"],
    ["測量工程師", "Surveyor"],
    ["邊界遮罩", "Mask Boundary"],
    ["在 3D 掃描上點擊 3+ 點定義自訂遮罩邊界", "Click 3+ points on 3D scan to define custom mask boundary"],
    ["重設為預設掃描邊界", "Reset to default scan footprint boundary"],
    ["繪製", "Draw"],
    ["重設", "Reset"],
    ["濾除樹木與建物之純地形等高線", "Bare-Earth DTM Contours"],
    ["產製測量圖資報表 (.DXF + A3 PDF)", "Create Survey Report (.DXF + A3 PDF)"],
    ["產製 AutoCAD / Civil 3D (.DXF) 與 A3 標準圖框工程報告 PDF", "Generate .DXF (AutoCAD / Civil 3D) & A3 Ready-to-Print PDF Survey Report"],

    // 4. Cross-Section Profile Inspector
    ["計算 / 重新取樣斷面高程", "Compute / Resample Cross-Section Profile"],
    ["計算斷面", "Compute Profile"],
    ["取樣計算中...", "Sampling..."],
    ["在 3D 掃描上重選斷面 A → B", "Pick New Section A → B Line on 3D Scan"],
    ["重選 A–B 線", "New A–B Line"],
    ["匯出斷面 CSV", "Export Cross-Section CSV"],
    ["滑鼠移至圖表預覽樁號高程", "Hover chart to inspect station"],
    ["斷面總長", "Section Length"],
    ["最大局部坡度", "Max Local Grade"],
    ["高程範圍 (H)", "Elev Range (H)"],
    ["最大高差 ΔZ", "Max Relief ΔZ"],
    ["請在 3D 掃描上點擊起點 A 與終點 B", "Click Start Point A and End Point B on the 3D scan"],
    ["已下載斷面分析 CSV", "Downloaded Cross-Section Profile CSV"],

    // 5. RTK Camera Photo Inspector
    ["正在查詢校正後之 PIX4Dcatch RTK 相機姿態...", "Querying calibrated PIX4Dcatch RTK camera poses..."],
    ["此座標點附近無本地原始照片。", "No local raw photos found for this point."],
    ["目標座標：", "Target: "],

    // 6. Section Box Slicer Inspector
    ["東西向裁切範圍 (±X m)", "East-West Clipping Bound (±X m)"],
    ["南北向裁切範圍 (±Z m)", "North-South Clipping Bound (±Z m)"],
    ["頂部高程裁切上限 (+Y m)", "Top Ceiling Bound (+Y Elevation m)"],
    ["底部高程裁切下限 (-Y m)", "Bottom Floor Bound (-Y Elevation m)"],
    ["關閉面板後保留剖面裁切", "Keep Clipping Active When Panel Closed"],
    ["重設剖面盒裁切面", "Reset Clipping Planes"],
    ["重設剖面盒", "Reset Section Box"],
    ["已重設剖面盒裁切", "Section Box clipping reset"],

    // 7. 3D Geo-Comments Inspector
    ["請在 3D 掃描任意位置點擊放置標註圖釘，並於下方輸入工程備註。", "Click anywhere on the 3D scan to place the comment pin, then write your note below."],
    ["您的姓名", "Your Name"],
    ["例如：審查工程師姓名", "e.g. Reviewer Name"],
    ["圖釘座標：", "Pin Coordinate: "],
    ["輸入現場工程觀察或審查意見...", "Leave an engineering observation..."],
    ["發佈 3D 標註圖釘", "Post 3D Comment Pin"],
    ["發佈標註", "Post"],
    ["已發佈 3D 空間標註", "Posted 3D geo-referenced comment"],

    // 8. AI Categorization Inspector & Manual Edit Modes
    ["結合 3D 網格幾何分析（純地形 DTM、1.3m 胸高樹幹切片與 Pratt 圓擬合 DBH、水域空洞岸際等高線夾取、3D PCA 牆面共面分析）與 Gemini 3.6 Flash 多模態驗證。", "Combines 3D Mesh Geometry (Bare-Earth DTM, 1.3m Breast-Height Trunk Slicing + Pratt Circle DBH, Un-Modelled Water Void Shoreline Clamping, 3D PCA Wall Coplanarity) with Gemini 3.6 Flash Multimodal verification."],
    ["執行 / 顯示 AI 地物分類", "Analyze & Show 3D Overlays"],
    ["強制重新計算並執行 Gemini 多模態分析", "Force Recompute & Re-run Gemini Multimodal Analysis"],
    ["↻ 重新計算", "↻ Recompute"],
    ["⏳ 正在從伺服器載入已儲存之 AI 分類結果（或分析 3D 網格）...", "⏳ Loading saved AI classification from server (or analyzing 3D mesh triangles)..."],
    ["點選上方按鈕後，直接點擊 3D 場景即可新增或刪除分類項目", "Click a mode button above, then click directly on the 3D scene to add or remove items"],
    ["🟢 新增喬木模式：請點擊 3D 場景中的樹木位置", "🟢 Add Tree Mode: Click tree location on the 3D model"],
    ["🗑️ 點選刪除模式：點擊 3D 場景中的樹木/牆面/道路，或點擊下方表格 🗑️ 即可刪除", "🗑️ Remove Mode: Click any tree/wall/road in 3D or click 🗑️ in the table below"],
    ["💾 已儲存於伺服器", "💾 Saved on Server"],
    ["顯示中", "Visible"],
    ["預設隱藏", "Hidden by Default"],
    ["顯示 3D 地物分類圖層", "Show 3D Overlays"],
    ["👁️ 顯示中 · 點擊隱藏 3D 圖層", "👁️ Visible · Click to Hide 3D Layer"],
    ["👁️‍🗨️ 預設隱藏 · 點擊顯示 3D 圖層", "👁️‍🗨️ Hidden by Default · Click to Show 3D Layer"],
    ["👁️ 顯示中 (點擊隱藏 3D 圖層)", "👁️ Visible · Click to Hide 3D Layer"],
    ["👁️‍🗨️ 預設隱藏 (點擊顯示 3D 圖層)", "👁️‍🗨️ Hidden by Default · Click to Show 3D Layer"],
    ["🏷️ 顯示 2D 浮動標籤", "🏷️ Show 2D Floating Labels"],
    ["標籤開啟", "Labels On"],
    ["僅保留 3D 幾何", "3D Geometry Only"],
    ["🛠️ 手動新增 / 刪除分類", "🛠️ Manual Add / Remove Classification"],
    ["還原所有手動新增或刪除的項目", "Reset Manual Overrides"],
    ["↺ 重設手動變更", "↺ Reset Edits"],
    ["➕ 喬木", "➕ Tree"],
    ["➕ 擋土牆", "➕ Wall"],
    ["➕ 道路", "➕ Road"],
    ["🗑️ 點選刪除", "🗑️ Click to Remove"],
    ["🛣️ 道路鋪面", "🛣️ Roads"],
    ["🌳 喬木與胸徑", "🌳 Trees & DBH"],
    ["💧 水體與河道空洞", "💧 Water & Voids"],
    ["🧱 擋土牆與垂直面", "🧱 Retaining Walls"],
    ["無水域", "None"],
    ["岸際等位面", "shoreline contour"],
    ["乾燥陸域場址", "dry terrestrial site"],
    ["總長 L", "Total L"],
    ["PCA 共面", "PCA coplanar"],
    ["3D 子圖層開關", "3D Scene Overlay Filters"],
    ["喬木 DBH", "Trees DBH"],
    ["水域空洞", "Water Voids"],
    ["土石堆置", "Stockpiles"],
    ["擋土牆", "Walls"],
    ["道路", "Roads"],
    ["水域", "Water"],
    ["土石", "Stockpiles"],
    ["全部", "All"],
    ["全場地物面積組成", "Site Surface Breakdown"],
    ["類別", "Type"],
    ["主量測值", "Primary Metric"],
    ["次要參數 (點擊定位)", "Secondary (Click to Fly)"],
    ["刪除", "Del"],
    ["刪除此分類項目", "Remove"],
    ["請先選擇掃描檔", "No active scan selected"],
    ["↺ 已還原所有手動新增/刪除變更", "↺ Reset all manual classification edits"],
    ["已取消手動編輯模式", "Cancelled manual edit mode"],
    ["👁️ AI 分類: 顯示", "👁️ AI Class: On"],
    ["👁️‍🗨️ AI 分類: 隱藏", "👁️‍🗨️ AI Class: Off"],
    ["🏷️ 標籤: 顯示", "🏷️ Labels: On"],
    ["🏷️ 標籤: 隱藏", "🏷️ Labels: Off"],
    ["🏷️ AI 分類 2D 浮動標籤：顯示中", "🏷️ 2D Classification Labels: Visible"],
    ["🏷️ AI 分類 2D 浮動標籤：已隱藏", "🏷️ 2D Classification Labels: Hidden"],

    // 9. Lasso Delete & Crop Keep Inspectors
    ["🔗 多掃描模式：返回對齊視窗時將完整保留已選取與已刪除的多邊形範圍。", "🔗 Multi-Scan Mode: Selected & deleted polygons stay preserved when returning to Alignment."],
    ["🎯 返回對齊", "🎯 Return to Alignment"],
    ["🗑️ 標記欲刪除之網格範圍", "🗑️ Mark Polygons for Deletion"],
    ["✂️ 標記欲保留之網格範圍", "✂️ Mark Region(s) to Keep"],
    ["✋ 旋轉視角 (Esc)", "✋ Orbit (Esc)"],
    ["環繞視角模式", "Orbit Mode"],
    ["✏️ 3D 自由套索", "✏️ Freehand 3D Lasso"],
    ["📐 多邊形點選", "📐 Plan Polygon"],
    ["僅選取可見前景表面", "Protect Occluded Background"],
    ["避免誤刪被前景遮蔽之後方牆面、道路或地形。", "Prevents deleting walls, roads, or terrain hidden behind foreground objects."],
    ["已標記：", "Marked: "],
    ["尚未標記", "None yet"],
    ["復原標記", "Undo Mark"],
    ["清除", "Clear"],
    ["啟用套索標記刪除", "Select with Lasso — Mark for Deletion"],
    ["🗑️ 刪除 (請先用套索標記範圍)", "🗑️ Delete (Mark polygons with Lasso first)"],
    ["↩️ 復原上一步刪除", "↩️ Undo Last Delete"],
    ["還原全部刪除範圍", "Restore All Deleted"],
    ["🩹 從原始掃描補回誤刪缺口", "🩹 Restore Accidentally Deleted Area"],
    ["在上方缺口處畫出 3D 自由套索或多邊形，點擊下方按鈕即可從未修改的原始 4K 掃描補回網格。", "Draw a Freehand 3D Lasso or Plan Polygon over any missing gap above, then click below to splice the missing triangles back from the untouched original scan at full 4K quality."],
    ["排除懸浮碎塊（僅補回邊界相連表面）", "Boundary-connected surface only"],
    ["僅補回與周圍道路/牆面相連之表面，自動略過空中懸浮碎塊。", "Restores surfaces connected to surrounding road/walls while skipping floating sky/tree debris."],
    ["🩹 啟用套索圈選缺口", "🩹 Activate Lasso to Mark Gap for Restore"],
    ["🩹 補回誤刪區域 (請先用套索圈選缺口)", "🩹 Restore Deleted Area (Circle missing gap with Lasso first)"],
    ["啟用框選保留", "Select Keep Boundary"],
    ["✂️ 套用框選保留 (請先標記欲保留範圍)", "✂️ Stage Keep Crop (Mark region to keep first)"],
    ["🗑️ 已標記刪除", "🗑️ Marked for Deletion"],
    ["✂️ 已標記保留", "✂️ Marked to Keep"],

    // 10. Mesh Compression, CRS, and Save Scan Edits Inspectors
    ["📊 目前掃描規格", "📊 Active Scan Metrics"],
    ["網格面數", "Polygon Count"],
    ["貼圖解析度", "Texture Size"],
    ["檔案大小 (MB)", "Scan Size (MB)"],
    ["⚡ GC_ScanOptimizer 壓縮預設集", "⚡ GC_ScanOptimizer Compression Preset"],
    ["選擇產生新掃描版本時要套用的網格簡化與貼圖優化等級（完整保留 64 位元座標精度）。", "Choose mesh decimation & texture optimization to apply when generating your new scan (64-bit coordinate precision preserved)."],
    ["壓縮與串流等級", "Target Compression Level"],
    ["不額外壓縮 (100% 原始網格與貼圖)", "No Extra Compression (100% Original Mesh & Textures)"],
    ["高畫質品質 (75% 面數 · 2048px JPEG)", "High Fidelity Quality (75% Tris · 2048px JPEG)"],
    ["平衡網頁串流 (50% 面數 · 1536px JPEG)", "Balanced Web Stream (50% Tris · 1536px JPEG)"],
    ["行動平板快速瀏覽 (35% 面數 · 1024px JPEG)", "Fast Field Tablet (35% Tris · 1024px JPEG)"],
    ["超輕量離線快取 (20% 面數 · 768px JPEG)", "Ultra-Light Offline Cache (20% Tris · 768px JPEG)"],
    ["⚡ 加入壓縮設定", "⚡ Stage Compression Adjustment"],
    ["🌐 座標參考系統 (CRS)", "🌐 Coordinate Reference System (CRS)"],
    ["目前掃描座標系：", "Current Scan CRS:"],
    ["目前中心點：", "Current Center:"],
    ["目標座標系統", "Target Coordinate System"],
    ["自訂平移量 ΔX / ΔY / ΔZ (m)", "Optional Custom Datum Offset ΔX / ΔY / ΔZ (m)"],
    ["🌐 加入座標系統設定", "🌐 Stage Coordinate System"],
    ["🗑️ 原掃描 → 回收桶", "🗑️ Original → Trash Bin"],
    ["🗑️ 原掃描群 → 回收桶", "🗑️ Originals → Trash Bin"],
    ["尚未加入任何修改。請先使用左側工具列的「套索刪除」、「網格優化」或「座標系統」，再點擊「儲存變更」！", "No adjustments staged yet. Use Lasso Delete, Mesh Compression, or Coordinate System on the left dock first, then press Save Edits!"],
    ["+ 刪除範圍", "+ Delete Regions"],
    ["+ 壓縮優化", "+ Compression"],
    ["+ 座標系統", "+ Coordinate System"],
    ["掃描名稱（原掃描將自動備份至回收桶）", "Scan Name (original scan backed up to Trash Bin)"],
    ["輸入掃描名稱...", "Enter scan name..."],
    ["💾 儲存變更", "💾 Save Edits"],
    ["🗑️ 開啟回收桶檢視 / 還原備份", "🗑️ Open Trash Bin to View / Restore Backup"],
    ["已套用之修改項目：", "Applied Adjustments:"],

    // 11. Multi-Scan Align & Merge Inspector
    ["1. 選擇要加入的掃描", "1. Select Scans to Add"],
    ["全選", "Select All"],
    ["3D 控制軸模式：", "3D Gizmo Mode:"],
    ["平移 + 旋轉 (R)", "Move + Rotate (R)"],
    ["平移 (W)", "Move (W)"],
    ["旋轉 (E)", "Rotate (E)"],
    ["🔓 全部解鎖", "🔓 Unlock All"],
    ["合併後新掃描名稱", "Unified Scan Name"],
    ["目標工區群組", "Target Project Site"],
    ["合併後網格優化", "Post-Merge Optimizer"],
    ["保留原始合併網格", "Keep Native Merged Mesh"],
    ["自動執行平衡優化 (50% 面數)", "Auto-Run Balanced (50% Tris)"],
    ["自動執行高畫質優化 (75% 面數)", "Auto-Run High Quality (75% Tris)"],
    ["自動執行平板快速優化 (35% 面數)", "Auto-Run Fast Tablet (35% Tris)"],
    ["自動執行超輕量優化 (20% 面數)", "Auto-Run Ultra-Light (20% Tris)"],
    ["選填：合併後將個別原掃描移至回收桶（預設保留所有個別掃描）", "Optional: move individual source scans to Trash Bin after merge (default keeps all individual scans)"],
    ["退出多掃描對齊檢視", "Exit Multi-Scan Alignment View"],
    ["多掃描合併編輯中暫停使用，請先合併掃描或退出多掃描模式", "Unavailable during Multi-Scan Editing — merge scans first (or exit Multi-Scan mode)"],

    // 12. Mobile Tool HUD & Side Panel Collapse
    ["🔄 旋轉中 (點此套索)", "🔄 Orbiting (Tap to Lasso)"],
    ["✏️ 套索標記 (點此旋轉)", "✏️ Lasso (Tap to Orbit)"],
    ["✓ 完成多邊形", "✓ Lock Polygon"],
    ["✓ 執行刪除", "✓ Delete"],
    ["✓ 執行保留", "✓ Keep"],
    ["✓ 鎖定", "✓ Lock"],
    ["↩ 復原", "↩ Undo"],
    ["▴ 面板", "▴ Panel"],
    ["▾ 收合", "▾ Hide"],
    ["▴ 展開", "▴ Expand"],
    ["✕ 離開", "✕ Exit"],

    // 13. 2D Measurement Badges (Distance, Angle, Coordinate, Laser)
    ["起點 (請點擊終點)", "Start Point (Click end point)"],
    ["📐 起點 P1", "📐 Start P1"],
    ["點擊設定第一邊", "Click to set 1st leg"],
    ["請點擊角頂點 P2", "Click vertex P2"],
    ["點擊確認頂點 P2", "Click to confirm P2"],
    ["頂點已鎖定 · 移動滑鼠預覽夾角", "Vertex locked · Move mouse to preview angle"],
    ["頂點 P2", "Vertex P2"],
    ["🔴 雷射高程 H", "🔴 Laser Elev H"],
    ["室內 寬", "Room W"],
    ["橫坡", "Cross Slope"],
    ["坡度", "Slope"],
    ["路寬", "Road W"],
    ["淨寬", "Clear W"],
    ["淨高", "Clear H"],
    ["面積", "Area"],
    ["水平", "Horiz"],
    ["× 長", "× L"],

    // 14. First-Person Walk / Fly HUD & Toasts
    ["🎮 第一人稱漫遊開啟 — 左下方向鍵移動 · 單指拖曳旋轉視角 · 頂部切換飛行/步行", "🎮 First-Person Walk/Fly active — Use bottom-left D-pad to move · Drag to look · Top bar toggles Fly/Walk"],
    ["🎮 第一人稱漫遊開啟 — WASD 移動 · 滑鼠拖曳或點擊鎖定視角 · 滾輪調速 · G 切換步行/飛行", "🎮 First-Person Walk/Fly active — WASD to move · Drag or click to look · Scroll wheel speed · G toggles Walk/Fly"],
    ["已離開第一人稱漫遊，返回環繞視角", "Exited First-Person mode, returned to Orbit mode"],
    ["已瞬移至目標位置", "Teleported to target location"],
    ["跳躍", "Jump"],
    ["蹲下", "Crouch"],
    ["上升", "Up"],
    ["下降", "Down"],
    ["行人重力模式", "Walk Gravity Mode"],
    ["自由飛行模式", "Free Fly Mode"],

    // 15. Topbar, Status, Download Popover, Recycle Bin, User Auth, Timeline
    ["選擇下載格式", "Download 3D Scan"],
    ["工作站連線", "Queue"],
    ["離線模式", "Offline"],
    ["模擬離線", "Offline"],
    ["恢復連線", "Online"],
    ["全部工區", "All Project Sites"],
    ["篩選工區", "Filtered Projects"],
    ["原始備份與已刪除掃描可隨時還原 · 永久刪除將從磁碟移除檔案。", "Original backups & deleted scans can be restored anytime · Permanent delete removes files from disk."],
    ["原始備份與已刪除掃描可隨時還原（永久刪除需管理員權限）。", "Original backups & deleted scans can be restored anytime (Permanent delete requires Admin / Owner)."],
    ["移至回收桶", "Move to Bin"],
    ["移至回收桶中...", "Moving to Bin..."],
    ["回收桶目前沒有掃描備份或檔案。", "Recycle Bin is empty."],
    ["原始備份", "Backup"],
    ["將此掃描還原至地圖與 3D 工作台", "Restore this scan back to Map & Studio"],
    ["從磁碟永久刪除此掃描與檔案", "Permanently delete this scan and its files from disk"],
    ["還原中...", "Restoring..."],
    ["還原", "Restore"],
    ["刪除中...", "Deleting..."],
    ["永久刪除", "Delete Forever"],
    ["刪除掃描", "Delete Scan"],
    ["修改掃描名稱", "Edit Scan Name"],
    ["修改名稱與日期", "Edit Scan Name & Date"],
    ["正在驗證 Google 帳號與權限...", "Verifying Google account & role permissions..."],
    ["未登入", "Not signed in"],
    ["登入", "Sign In"],
    ["管理員", "Admin"],
    ["標準成員", "Member"],
    ["唯讀訪客", "Read-Only Guest"],
    ["訪客檢視", "Guest Viewer"],
    ["訪客", "Guest"],
    ["已登入：", "Signed in as: "],
    ["尚無排程任務", "No queued tasks"],
    ["尚無分享連結", "No share links created yet"],
    ["複製連結", "Copy Link"],
    ["已複製", "Copied"],
    ["撤銷", "Revoke"],
    ["離線快取已更新", "Offline cache updated"],
    ["快取此掃描供離線瀏覽", "Cache Scan for Offline Viewing"],
    ["已快取", "Cached"]
  ];

  // Technical parenthetical tokens that are NOT bilingual translations and must NEVER be stripped
  var KEEP_PAREN_TOKENS = /^(TWD97|TWVD2001|WGS84|EPSG[:\d+.\sA-Za-z-]*|121|120|119|\.3TZ|\.GLB|\.OBJ|\.ZIP|\.DXF|\.CSV|\.PDF|\.LAS|\.LAZ|\.JSON|0,0,0|0,\s*0,\s*0|XY|XYZ|Z|R|W|E|G|Esc|m|m²|m³|t\/m³|cm|mm|km|%|°|DBH|H|L|D|V\d+|P\d+|±[A-Za-z0-9\s+-]+|\+[A-Za-z0-9\s+-]+|-[A-Za-z0-9\s+-]+|\d+[\d\s.,/%+~A-Za-z-]*)$/i;

  /**
   * Strips bilingual parenthetical translations such as:
   *   "Recycle Bin (掃描回收桶)" -> "掃描回收桶" (in zh-TW) or "Recycle Bin" (in en)
   *   "掃描回收桶 (Recycle Bin)" -> "掃描回收桶" (in zh-TW) or "Recycle Bin" (in en)
   */
  function stripBilingualBrackets(text, lang) {
    if (!text || typeof text !== "string") return text;
    var target = lang || currentLang;

    // Pattern 1: ASCII/English phrase followed by (Chinese phrase)
    var out = text.replace(/([A-Za-z0-9][A-Za-z0-9\s\/&.,:_+→–—-]{1,75}?)\s*\(([^()]*[\u4e00-\u9fff][^()]*)\)/g, function (match, enPart, zhPart) {
      var enClean = enPart.trim();
      var zhClean = zhPart.trim();
      if (!enClean || !zhClean) return match;
      // If zhPart has " · " with numbers/steps like "(1 adjustment · 儲存變更)", handle gracefully
      if (/^\d+\s+(step|adjustment|selected|marked|kept)/i.test(zhClean)) {
        var subParts = zhClean.split("·");
        if (subParts.length === 2) {
          return target === "en" ? enClean + " (" + subParts[0].trim() + ")" : subParts[1].trim() + " (" + subParts[0].trim() + ")";
        }
      }
      return target === "en" ? enClean : zhClean;
    });

    // Pattern 2: Chinese phrase followed by (ASCII/English phrase)
    out = out.replace(/([\u4e00-\u9fff][^\n()]{0,55}?)\s*\(([A-Za-z][A-Za-z0-9\s\/&.,:_+→–—-]{1,70})\)/g, function (match, zhPart, enPart) {
      var zhClean = zhPart.trim();
      var enClean = enPart.trim();
      if (KEEP_PAREN_TOKENS.test(enClean)) {
        return match;
      }
      return target === "en" ? enClean : zhClean;
    });

    // Pattern 3: Mixed inline bilingual strings like "顯示中 Visible" or "預設隱藏 Hidden by Default" or "Backup · 原始備份"
    out = out
      .replace(/顯示中\s+Visible/g, target === "en" ? "Visible" : "顯示中")
      .replace(/預設隱藏\s+Hidden by Default/g, target === "en" ? "Hidden by Default" : "預設隱藏")
      .replace(/全部\s+All/g, target === "en" ? "All" : "全部")
      .replace(/➕\s*喬木\s+Tree/g, target === "en" ? "➕ Tree" : "➕ 喬木")
      .replace(/➕\s*擋土牆\s+Wall/g, target === "en" ? "➕ Wall" : "➕ 擋土牆")
      .replace(/➕\s*道路\s+Road/g, target === "en" ? "➕ Road" : "➕ 道路")
      .replace(/🛣️\s*道路鋪面\s+Roads/g, target === "en" ? "🛣️ Roads" : "🛣️ 道路鋪面")
      .replace(/🌳\s*喬木與胸徑\s+Trees/g, target === "en" ? "🌳 Trees & DBH" : "🌳 喬木與胸徑")
      .replace(/💧\s*水體與河道空洞\s+Water/g, target === "en" ? "💧 Water & Voids" : "💧 水體與河道空洞")
      .replace(/🧱\s*擋土牆與垂直面\s+Walls/g, target === "en" ? "🧱 Retaining Walls" : "🧱 擋土牆與垂直面")
      .replace(/刪除此分類項目\s+Remove/g, target === "en" ? "Remove" : "刪除此分類項目")
      .replace(/\b(Backup)\s*·\s*(原始備份)/g, target === "en" ? "Backup" : "原始備份");

    return out;
  }

  /**
   * Translates dynamic pattern strings with embedded numbers/counts.
   */
  function applyParameterizedTranslations(str, target) {
    if (!str || typeof str !== "string") return str;
    var out = str;
    if (target === "zh-TW") {
      out = out
        .replace(/Lock \((\d+) pts\) & Compute/g, "鎖定 ($1 點) 並計算")
        .replace(/Drawing Polygon: (\d+) \/ 3\+ vertices placed/g, "繪製多邊形中：已放置 $1 / 3+ 個頂點")
        .replace(/Ready to Lock: (\d+) vertices placed/g, "可鎖定計算：已放置 $1 個頂點")
        .replace(/3D Geo-Comments \((\d+)\)/g, "3D 空間標註 ($1)")
        .replace(/✨ Pending Adjustments \((\d+)\)/g, "✨ 待套用修改 ($1)")
        .replace(/\+ Add Selected Scans to 3D View \((\d+) Checked\)/g, "+ 將勾選掃描加入 3D 檢視 (已選 $1 項)")
        .replace(/2\. Active 3D Layers \((\d+) Loaded\)/g, "2. 作用中 3D 圖層 (已載入 $1 項)")
        .replace(/🔒 Lock All Orientations \((\d+)\/(\d+)\)/g, "🔒 鎖定全部方位 ($1/$2)")
        .replace(/Merge (\d+) Locked Scans into Unified Scan/g, "合併 $1 組已鎖定掃描為單一模型")
        .replace(/Lock All Scans \(🔒\) to Merge \((\d+)\/(\d+) Locked\)/g, "請先鎖定所有掃描 (🔒) 以執行合併 ($1/$2 已鎖定)")
        .replace(/(\d+) Site(s?) · (\d+) Scan(s?)/g, "$1 個工區 · $3 組掃描")
        .replace(/^(\d+) Scan(s?)$/g, "$1 組掃描")
        .replace(/^(\d+) Member(s?)$/g, "$1 位成員")
        .replace(/All Projects \((\d+) Sites · (\d+) Scans\)/g, "全部工區 ($1 個工區 · $2 組掃描)")
        .replace(/Filtered Projects \((\d+) Sites · (\d+) Scans\)/g, "篩選工區 ($1 個工區 · $2 組掃描)");
    } else {
      out = out
        .replace(/鎖定 \((\d+) 點\) 並計算/g, "Lock ($1 pts) & Compute")
        .replace(/繪製多邊形中：已放置 (\d+) \/ 3\+ 個頂點/g, "Drawing Polygon: $1 / 3+ vertices placed")
        .replace(/可鎖定計算：已放置 (\d+) 個頂點/g, "Ready to Lock: $1 vertices placed")
        .replace(/3D 空間標註 \((\d+)\)/g, "3D Geo-Comments ($1)")
        .replace(/✨ 待套用修改 \((\d+)\)/g, "✨ Pending Adjustments ($1)")
        .replace(/\+ 將勾選掃描加入 3D 檢視 \(已選 (\d+) 項\)/g, "+ Add Selected Scans to 3D View ($1 Checked)")
        .replace(/2\. 作用中 3D 圖層 \(已載入 (\d+) 項\)/g, "2. Active 3D Layers ($1 Loaded)")
        .replace(/🔒 鎖定全部方位 \((\d+)\/(\d+)\)/g, "🔒 Lock All Orientations ($1/$2)")
        .replace(/合併 (\d+) 組已鎖定掃描為單一模型/g, "Merge $1 Locked Scans into Unified Scan")
        .replace(/請先鎖定所有掃描 \(🔒\) 以執行合併 \((\d+)\/(\d+) 已鎖定\)/g, "Lock All Scans (🔒) to Merge ($1/$2 Locked)")
        .replace(/(\d+) 個工區 · (\d+) 組掃描/g, "$1 Sites · $2 Scans")
        .replace(/^(\d+) 組掃描$/g, "$1 Scans")
        .replace(/^(\d+) 位成員$/g, "$1 Members")
        .replace(/全部工區 \((\d+) 個工區 · (\d+) 組掃描\)/g, "All Projects ($1 Sites · $2 Scans)")
        .replace(/篩選工區 \((\d+) 個工區 · (\d+) 組掃描\)/g, "Filtered Projects ($1 Sites · $2 Scans)")
        .replace(/(\d+)\s*棵\)/g, "$1)");
    }
    return out;
  }

  var ZH_TO_EN_EXACT = Object.create(null);
  var EN_TO_ZH_EXACT = Object.create(null);
  for (var _pi = 0; _pi < PHRASE_PAIRS.length; _pi++) {
    var _zhKey = PHRASE_PAIRS[_pi][0];
    var _enKey = PHRASE_PAIRS[_pi][1];
    if (_zhKey && !ZH_TO_EN_EXACT[_zhKey]) ZH_TO_EN_EXACT[_zhKey] = _enKey;
    if (_enKey && !EN_TO_ZH_EXACT[_enKey]) EN_TO_ZH_EXACT[_enKey] = _zhKey;
  }

  /**
   * Translates a plain text string into the active language and removes any bilingual bracketed text.
   * Never performs blind substring replacement on short English words (preventing "Deletion" -> "刪除etion").
   */
  function translateDynamicText(str, lang) {
    if (!str || typeof str !== "string") return str;
    var target = lang || currentLang;
    var result = stripBilingualBrackets(str, target);
    var trimmed = result.trim();
    if (!trimmed) return result;

    if (target === "en" && ZH_TO_EN_EXACT[trimmed]) {
      return result.replace(trimmed, ZH_TO_EN_EXACT[trimmed]);
    }
    if (target === "zh-TW" && EN_TO_ZH_EXACT[trimmed]) {
      return result.replace(trimmed, EN_TO_ZH_EXACT[trimmed]);
    }

    for (var i = 0; i < PHRASE_PAIRS.length; i++) {
      var zh = PHRASE_PAIRS[i][0];
      var en = PHRASE_PAIRS[i][1];
      if (target === "en") {
        if (zh.length >= 2 && result.indexOf(zh) !== -1) {
          result = result.split(zh).join(en);
        }
      } else {
        // Only replace multi-word English phrases (>= 8 chars with space) inside composite strings
        if (en.length >= 8 && en.indexOf(" ") !== -1 && result.indexOf(en) !== -1) {
          result = result.split(en).join(zh);
        }
      }
    }
    result = applyParameterizedTranslations(result, target);
    return result;
  }

  /**
   * Safely translates text nodes and title/placeholder attributes inside an HTML string
   * without corrupting HTML tags, class names, IDs, or user data attributes.
   */
  function translateDynamicHtml(html, lang) {
    if (!html || typeof html !== "string") return html;
    var target = lang || currentLang;

    var parts = html.split(/(<[^>]+>)/g);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      if (part.charAt(0) === "<" && part.charAt(part.length - 1) === ">") {
        parts[i] = part
          .replace(/\b(title|placeholder)="([^"]*)"/g, function (_, attr, val) {
            return attr + '="' + translateDynamicText(val, target) + '"';
          })
          .replace(/\b(title|placeholder)='([^']*)'/g, function (_, attr, val) {
            return attr + "='" + translateDynamicText(val, target) + "'";
          });
      } else {
        parts[i] = translateDynamicText(part, target);
      }
    }
    return parts.join("");
  }

  /**
   * Updates the topbar and auth-gate language toggle buttons so they always show the OPPOSING language:
   * - When currentLang === "zh-TW" -> button label is "EN", title is "Switch to English"
   * - When currentLang === "en"    -> button label is "中文", title is "切換至繁體中文"
   */
  function syncLanguageToggleButtons() {
    var nextLabel = currentLang === "zh-TW" ? "EN" : "中文";
    var nextTitle = currentLang === "zh-TW" ? "Switch to English" : "切換至繁體中文";

    var btnTop = document.getElementById("btnToggleLanguage");
    var lblTop = document.getElementById("lblToggleLanguage");
    if (lblTop) lblTop.textContent = nextLabel;
    if (btnTop) {
      btnTop.setAttribute("title", nextTitle);
      btnTop.setAttribute("aria-label", nextTitle);
      if (!lblTop) btnTop.textContent = nextLabel;
    }

    var btnAuth = document.getElementById("btnAuthToggleLanguage");
    var lblAuth = document.getElementById("lblAuthToggleLanguage");
    if (lblAuth) lblAuth.textContent = nextLabel;
    if (btnAuth) {
      btnAuth.setAttribute("title", nextTitle);
      btnAuth.setAttribute("aria-label", nextTitle);
    }
  }

  /**
   * Applies static [data-i18n-*] attributes across `root` (defaults to `document`).
   */
  function applyStaticDomTranslations(root) {
    var scope = root || document;
    if (!scope || !scope.querySelectorAll) return;

    var isEn = currentLang === "en";
    if (document.documentElement) {
      document.documentElement.setAttribute("lang", isEn ? "en" : "zh-TW");
    }

    // 1. Text / HTML content elements
    var textEls = scope.querySelectorAll("[data-i18n-zh], [data-i18n-en]");
    for (var i = 0; i < textEls.length; i++) {
      var el = textEls[i];
      if (
        el.id === "btnToggleLanguage" ||
        el.id === "lblToggleLanguage" ||
        el.id === "btnAuthToggleLanguage" ||
        el.id === "lblAuthToggleLanguage"
      ) {
        continue;
      }
      var targetVal = isEn ? el.getAttribute("data-i18n-en") : el.getAttribute("data-i18n-zh");
      if (targetVal === null || targetVal === undefined) continue;

      var cleanVal = stripBilingualBrackets(targetVal, currentLang);

      if (el.children.length === 0) {
        if (el.textContent !== cleanVal) {
          el.textContent = cleanVal;
        }
      } else {
        if (/<[a-z][\s\S]*>/i.test(cleanVal)) {
          el.innerHTML = cleanVal;
        } else {
          var replacedTextNode = false;
          for (var c = el.childNodes.length - 1; c >= 0; c--) {
            var node = el.childNodes[c];
            if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim().length > 0) {
              node.nodeValue = " " + cleanVal;
              replacedTextNode = true;
              break;
            }
          }
          if (!replacedTextNode) {
            var span = el.querySelector("span:not(.status-dot):not(.gs-crs-pill)");
            if (span && span.children.length === 0 && !span.hasAttribute("data-i18n-zh")) {
              span.textContent = cleanVal;
            }
          }
        }
      }
    }

    // 2. Title / Tooltip attributes
    var titleEls = scope.querySelectorAll("[data-i18n-title-zh], [data-i18n-title-en]");
    for (var j = 0; j < titleEls.length; j++) {
      var tel = titleEls[j];
      if (tel.id === "btnToggleLanguage" || tel.id === "btnAuthToggleLanguage") continue;
      var tVal = isEn ? tel.getAttribute("data-i18n-title-en") : tel.getAttribute("data-i18n-title-zh");
      if (tVal !== null && tVal !== undefined) {
        var cleanTitle = stripBilingualBrackets(tVal, currentLang);
        tel.setAttribute("title", cleanTitle);
      }
    }

    // 3. Placeholder attributes
    var phEls = scope.querySelectorAll("[data-i18n-placeholder-zh], [data-i18n-placeholder-en]");
    for (var k = 0; k < phEls.length; k++) {
      var pel = phEls[k];
      var pVal = isEn ? pel.getAttribute("data-i18n-placeholder-en") : pel.getAttribute("data-i18n-placeholder-zh");
      if (pVal !== null && pVal !== undefined) {
        pel.setAttribute("placeholder", stripBilingualBrackets(pVal, currentLang));
      }
    }

    syncLanguageToggleButtons();
  }

  /**
   * Persists the selected language to the backend user profile (`POST /api/user/preferences` & `/api/user-profiles`).
   */
  function persistLanguageToServer(lang) {
    try {
      var email = "";
      var sessTok = "";
      var userObj = (window.STATE && window.STATE.currentUser) || null;
      if (userObj && userObj.email) {
        email = userObj.email;
      }
      if (userObj && userObj.session_token) {
        sessTok = userObj.session_token;
      }
      var profileKeys = ["gathering_user_profile", "gs_current_user", "gs_user_profile_v1"];
      for (var k = 0; k < profileKeys.length; k++) {
        try {
          var raw = localStorage.getItem(profileKeys[k]);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
              if (!email && parsed.email) email = parsed.email;
              if (!sessTok && parsed.session_token) sessTok = parsed.session_token;
              if (!userObj && parsed.email) userObj = parsed;
              parsed.language = lang;
              localStorage.setItem(profileKeys[k], JSON.stringify(parsed));
            }
          }
        } catch (eStorage) {}
      }

      if (window.STATE && window.STATE.currentUser) {
        window.STATE.currentUser.language = lang;
      }

      var hdrs = { "Content-Type": "application/json" };
      if (email) hdrs["X-User-Email"] = email;
      if (sessTok) hdrs["X-Session-Token"] = sessTok;

      fetch("/api/user/preferences", {
        method: "POST",
        headers: hdrs,
        credentials: "same-origin",
        body: JSON.stringify({
          email: email,
          user_email: email,
          session_token: sessTok,
          language: lang,
        }),
      }).catch(function () {});

      if (email && sessTok) {
        fetch("/api/user-profiles", {
          method: "POST",
          headers: hdrs,
          credentials: "same-origin",
          body: JSON.stringify(
            Object.assign({}, userObj || {}, {
              email: email,
              language: lang,
              session_token: sessTok,
            })
          ),
        }).catch(function () {});
      }
    } catch (err) {
      // Ignore network errors in offline mode
    }
  }

  /**
   * Sets the active UI language ("zh-TW" or "en") and immediately re-translates static + dynamic UI.
   */
  function setAppLanguage(lang, options) {
    var opts = options || {};
    var normalized = normalizeLanguageCode(lang);
    var changed = normalized !== currentLang;
    currentLang = normalized;

    if (window.STATE && window.STATE.currentUser) {
      window.STATE.currentUser.language = currentLang;
    }

    try {
      localStorage.setItem(STORAGE_KEY, currentLang);
    } catch (e) {}

    applyStaticDomTranslations(document);

    // Re-translate active dynamic containers if already rendered in DOM
    var sidePanelTitle = document.getElementById("sidePanelTitle");
    if (sidePanelTitle && sidePanelTitle.innerHTML) {
      sidePanelTitle.innerHTML = translateDynamicHtml(sidePanelTitle.innerHTML, currentLang);
    }

    var overlay2D = document.getElementById("overlay2D");
    if (overlay2D) {
      var badges = overlay2D.querySelectorAll(".overlay-2d-badge");
      for (var b = 0; b < badges.length; b++) {
        badges[b].innerHTML = translateDynamicHtml(badges[b].innerHTML, currentLang);
      }
    }

    if (opts.saveToServer !== false) {
      persistLanguageToServer(currentLang);
    }

    if (typeof window.onAppLanguageChanged === "function") {
      try {
        window.onAppLanguageChanged(currentLang, changed);
      } catch (cbErr) {
        console.warn("[i18n] onAppLanguageChanged callback error:", cbErr);
      }
    }

    return currentLang;
  }

  function toggleAppLanguage() {
    window.__gsUserManuallyToggledLang = true;
    var next = currentLang === "zh-TW" ? "en" : "zh-TW";
    return setAppLanguage(next, { saveToServer: true });
  }

  // Bind delegated click handler for language toggle buttons (#btnToggleLanguage and #btnAuthToggleLanguage)
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("#btnToggleLanguage, #btnAuthToggleLanguage") : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    toggleAppLanguage();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      applyStaticDomTranslations(document);
    });
  } else {
    applyStaticDomTranslations(document);
  }

  // Export globals
  window.getAppLanguage = getAppLanguage;
  window.normalizeLanguageCode = normalizeLanguageCode;
  window.setAppLanguage = setAppLanguage;
  window.toggleAppLanguage = toggleAppLanguage;
  window.persistLanguageToServer = persistLanguageToServer;
  window.tr = tr;
  window.stripBilingualBrackets = stripBilingualBrackets;
  window.translateDynamicText = translateDynamicText;
  window.translateDynamicHtml = translateDynamicHtml;
  window.applyStaticDomTranslations = applyStaticDomTranslations;
})();
