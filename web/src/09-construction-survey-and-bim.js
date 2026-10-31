/**
 * GatheringScans Module 09: Construction Surveying, Earthwork Mass Conservation & Scan-to-BIM
 * =========================================================================================
 * Author: teamwork_worker (Civil Surveying & BIM Engineer)
 * Project: GatheringScans (scans.gatheren.cloud)
 *
 * Scope & Capabilities:
 * 1. Earthwork Mass Conservation Schedule:
 *    - Bank Volume (BCM m³), Loose Volume (LCM m³), and Compacted Volume (CCM m³)
 *    - Physical mass invariance identity: M_bank == M_loose == M_compact (conserved metric tonnes)
 *    - Dual-constraint Dump Truck Haul Trip Estimator (Volume-limited vs. Weight-limited)
 *    - Net Haul Site Balance (Surplus Export vs. Deficit Import vs. Balanced site)
 * 2. Least-Squares Best-Fit Reference Plane UI Inspection:
 *    - True 3D planar gradient (slope % and slope degrees)
 *    - Compass aspect/azimuth (0°–360° clockwise from North)
 *    - Planar normal equation parameters (a, b, c)
 * 3. User-selectable construction parameters:
 *    - Swell factor (Caterpillar expansion ratio or bulking %, e.g. 0.80 / 1.25)
 *    - Shrinkage / compaction factor (e.g. 0.10 / 10%)
 *    - Dump truck haul capacity (m³) & gross legal payload limit (tonnes)
 * 4. Scan-to-BIM & Trench Utility foundation interfaces.
 *
 * Compliance: Strictly under 5,000 lines modular architecture ceiling.
 */

(function () {
  "use strict";

  // Helper for safe client float parsing
  function safeParseFloat(val, fallback) {
    if (val === undefined || val === null) return fallback;
    const s = String(val).trim();
    if (!s || s.toLowerCase() === "undefined" || s.toLowerCase() === "null" || s.toLowerCase() === "nan") {
      return fallback;
    }
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : fallback;
  }

  /**
   * Generates bilingual HTML inputs for Earthwork Mass Conservation & Haul Truck Parameters.
   * Embeds into Cut/Fill Volume Inspector side panel.
   */
  function renderEarthworkInputFieldsHtml(defaultDatumZ) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const defZ = defaultDatumZ !== undefined ? defaultDatumZ : 0.0;

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;" class="gs-form-group">
        <div>
          <label>${t("比重 (t/m³)", "Density (t/m³)")}</label>
          <input type="number" step="0.05" class="gs-input" id="volCustomDensity" value="1.65" />
        </div>
        <div>
          <label>${t("基準高程 Z₀ (TWVD2001 m)", "Datum Elev Z₀ (TWVD2001 m)")}</label>
          <input type="number" step="0.1" class="gs-input" id="volDatumZ" value="${defZ}" />
        </div>
      </div>

      <div style="background:var(--ui-bg-subtle, rgba(255,255,255,0.03));border:1px solid var(--ui-border, rgba(255,255,255,0.08));border-radius:8px;padding:8px 10px;margin-bottom:9px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <span style="font-size:11px;font-weight:700;color:var(--ui-text-primary, #f1f5f9);">
            🚜 ${t("土方質量守恆與運料卡車參數", "Earthwork Mass & Truck Haul Parameters")}
          </span>
          <span style="font-size:10px;color:var(--ui-text-secondary, #94a3b8);">${t("工程預設", "Civil Std")}</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px;">
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary, #94a3b8);" title="${t("Caterpillar 鬆散膨脹率 (例如 1.25 表示膨脹 25%，或 0.80 表示載重率)", "Swell / Bulking Factor (e.g. 1.25 for 25% expansion, or 0.80 Cat load factor)")}">
              ${t("膨脹係數 (Swell)", "Swell Factor")}
            </label>
            <input type="number" step="0.05" class="gs-input" id="volSwellFactor" value="1.25" style="padding:4px 7px;font-size:11px;" />
          </div>
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary, #94a3b8);" title="${t("滾壓壓實收縮折減率 (例如 0.10 代表 10% 收縮折減)", "Compaction Shrinkage Factor (e.g. 0.10 for 10% compaction reduction)")}">
              ${t("收縮係數 (Shrink)", "Shrink Factor")}
            </label>
            <input type="number" step="0.05" class="gs-input" id="volShrinkFactor" value="0.10" style="padding:4px 7px;font-size:11px;" />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary, #94a3b8);" title="${t("砂石傾卸卡車單車鬆散斗容量 (m³，標準 10 輪車約 12-15 m³)", "Dump Truck Haul Volume Capacity (m³, std tandem 10-wheeler is 12-15 m³)")}">
              ${t("卡車容量 (m³)", "Truck Vol (m³)")}
            </label>
            <input type="number" step="1" class="gs-input" id="volTruckVolumeM3" value="15.0" style="padding:4px 7px;font-size:11px;" />
          </div>
          <div>
            <label style="font-size:10px;display:block;margin-bottom:2px;color:var(--ui-text-secondary, #94a3b8);" title="${t("傾卸卡車單車法定最大淨載重 (噸，標準雙橋車約 18-22 噸)", "Dump Truck Legal Max Payload (tonnes, std tandem is 18-22 t)")}">
              ${t("載重限制 (t)", "Truck Max (t)")}
            </label>
            <input type="number" step="1" class="gs-input" id="volTruckMaxTonnes" value="20.0" style="padding:4px 7px;font-size:11px;" />
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Collects and sanitizes Earthwork & Truck input values from DOM.
   */
  function getEarthworkInputValues(defaultDatumZ) {
    const densElem = document.getElementById("volCustomDensity");
    const datumElem = document.getElementById("volDatumZ");
    const swellElem = document.getElementById("volSwellFactor");
    const shrinkElem = document.getElementById("volShrinkFactor");
    const truckVolElem = document.getElementById("volTruckVolumeM3");
    const truckMaxElem = document.getElementById("volTruckMaxTonnes");

    return {
      density_t_m3: safeParseFloat(densElem ? densElem.value : null, 1.65),
      datum_elevation_m: safeParseFloat(datumElem ? datumElem.value : null, defaultDatumZ !== undefined ? defaultDatumZ : 0.0),
      swell_factor: safeParseFloat(swellElem ? swellElem.value : null, 1.25),
      shrinkage_factor: safeParseFloat(shrinkElem ? shrinkElem.value : null, 0.10),
      truck_volume_m3: safeParseFloat(truckVolElem ? truckVolElem.value : null, 15.0),
      truck_max_tonnes: safeParseFloat(truckMaxElem ? truckMaxElem.value : null, 20.0),
    };
  }

  /**
   * Renders the complete Earthwork Mass Conservation Schedule, Truck Trips, and Best-Fit Plane details.
   */
  function renderMassConservationScheduleHtml(res) {
    if (!res) return "";
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s);

    const cutBcm = res.cut_volume_bcm !== undefined ? res.cut_volume_bcm : safeParseFloat(res.cut_volume_m3, 0.0);
    const fillBcm = res.fill_volume_bcm !== undefined ? res.fill_volume_bcm : safeParseFloat(res.fill_volume_m3, 0.0);
    const cutLcm = res.cut_volume_lcm !== undefined ? res.cut_volume_lcm : (cutBcm * 1.25).toFixed(2);
    const fillCcm = res.fill_volume_ccm !== undefined ? res.fill_volume_ccm : (fillBcm * 0.90).toFixed(2);

    const cutMass = res.conserved_cut_mass_t !== undefined ? res.conserved_cut_mass_t : (cutBcm * (res.density_t_m3 || 1.65)).toFixed(2);
    const fillMass = res.conserved_fill_mass_t !== undefined ? res.conserved_fill_mass_t : (fillBcm * (res.density_t_m3 || 1.65)).toFixed(2);

    const truckCutTrips = res.truck_loads_cut !== undefined ? res.truck_loads_cut : 0;
    const netTruckTrips = res.net_truck_loads !== undefined ? res.net_truck_loads : truckCutTrips;
    const limitFactor = String(res.truck_limiting_factor || "volume").toLowerCase();
    const isWeightLimited = limitFactor.includes("weight");

    const haulDirection = res.net_haul_direction || (cutBcm > fillBcm ? "export_cut" : fillBcm > cutBcm ? "import_fill" : "balanced");

    // Best-fit reference plane information
    const bfp = res.best_fit_plane;
    let bfpHtml = "";
    if (bfp && (res.base_mode === "best_fit_plane" || bfp.slope_pct !== undefined)) {
      const slopePct = Number(bfp.slope_pct || 0).toFixed(2);
      const slopeDeg = Number(bfp.slope_deg || 0).toFixed(2);
      const azDeg = Number(bfp.azimuth_deg || 0).toFixed(1);
      bfpHtml = `
        <div style="margin-top:8px;padding-top:7px;border-top:1px dashed var(--ui-border, rgba(255,255,255,0.1));font-size:11px;line-height:1.4;">
          <div style="font-weight:700;color:var(--ui-accent, #38bdf8);margin-bottom:3px;">
            📐 ${t("最小平方法最佳擬合傾斜面", "Least-Squares Best-Fit Reference Plane")}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div><b>${t("坡度比率：", "Slope:")}</b> ${esc(slopePct)}% (${esc(slopeDeg)}°)</div>
            <div><b>${t("方位角：", "Azimuth:")}</b> ${esc(azDeg)}°</div>
          </div>
          <div style="font-size:10px;color:var(--ui-text-secondary, #94a3b8);margin-top:2px;">
            Z = ${Number(bfp.c || bfp.c0 || 0).toFixed(3)} + (${Number(bfp.a || 0).toFixed(4)} × dE) + (${Number(bfp.b || 0).toFixed(4)} × dN)
          </div>
        </div>
      `;
    }

    return `
      <div style="font-size:11px;color:var(--ui-text-secondary, #94a3b8);background:var(--ui-bg-subtle, rgba(255,255,255,0.03));padding:9px 10px;border-radius:8px;border:1px solid var(--ui-border, rgba(255,255,255,0.08));margin-bottom:10px;line-height:1.5;">
        <div style="font-weight:700;color:var(--ui-text-primary, #f1f5f9);margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;">
          <span>⚖️ ${t("土方質量守恆清單 (Mass Conservation Schedule)", "Mass Conservation & Haul Schedule")}</span>
          <span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:rgba(56,189,248,0.15);color:var(--ui-accent, #38bdf8);">
            ${haulDirection === "export_cut" ? t("出土 (外運)", "Surplus Export") : haulDirection === "import_fill" ? t("借土 (進料)", "Deficit Import") : t("平衡", "Balanced")}
          </span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:var(--ui-bg-card, rgba(0,0,0,0.25));border-radius:6px;padding:6px;margin-bottom:6px;text-align:center;">
          <div>
            <div style="font-size:10px;color:var(--ui-text-secondary, #94a3b8);">${t("自然實方 (BCM)", "Bank (BCM)")}</div>
            <div style="font-weight:700;color:var(--ui-text-primary, #f1f5f9);">${esc(String(cutBcm > 0 ? cutBcm : fillBcm))} m³</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--ui-text-secondary, #94a3b8);">${t("挖方鬆方 (LCM)", "Loose (LCM)")}</div>
            <div style="font-weight:700;color:#f59e0b;">${esc(String(cutLcm))} m³</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--ui-text-secondary, #94a3b8);">${t("填方壓實 (CCM)", "Compacted (CCM)")}</div>
            <div style="font-weight:700;color:var(--ui-accent, #38bdf8);">${esc(String(fillCcm))} m³</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:4px;">
          <div><b>${t("守恆質量 (挖)：", "Cut Mass:")}</b> ${esc(String(cutMass))} t</div>
          <div><b>${t("守恆質量 (填)：", "Fill Mass:")}</b> ${esc(String(fillMass))} t</div>
        </div>

        <div style="background:var(--ui-bg-pill, rgba(255,255,255,0.05));border-radius:6px;padding:5px 8px;margin-top:5px;display:flex;align-items:center;justify-content:space-between;">
          <div>
            <b>${t("卡車趟數：", "Truck Trips:")}</b>
            <span style="font-weight:700;color:#10b981;">${esc(String(truckCutTrips))} ${t("車次", "trips")}</span>
            ${netTruckTrips !== truckCutTrips ? `<span style="font-size:10px;color:var(--ui-text-secondary);">(${t("淨", "Net")} ${esc(String(netTruckTrips))})</span>` : ""}
          </div>
          <div style="font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid ${isWeightLimited ? "#f43f5e" : "#0284c7"};color:${isWeightLimited ? "#fda4af" : "#7dd3fc"};">
            ${isWeightLimited ? t("⚠️ 載重控制 (Weight)", "⚠️ Weight-Limited") : t("📦 容積控制 (Volume)", "📦 Volume-Limited")}
          </div>
        </div>

        ${bfpHtml}
      </div>
    `;
  }

  // =========================================================================
  // MILESTONE 2: 3D GCP ACCURACY QA, 1-CLICK TBM CALIBRATION & 3D VECTORS
  // =========================================================================

  /**
   * Safely disposes and clears all Three.js 3D GCP QA overlay markers and error vectors.
   */
  function clearEnhancedGcpQaMarkers3D() {
    if (!window.studioThree || !window.studioThree.overlayGroup) return;
    if (window.studioThree.gcpQaGroup) {
      window.studioThree.gcpQaGroup.traverse((obj) => {
        if (obj.geometry) {
          try { obj.geometry.dispose(); } catch (e) {}
        }
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => { try { m.dispose(); } catch (e) {} });
          } else {
            try { obj.material.dispose(); } catch (e) {}
          }
        }
      });
      window.studioThree.overlayGroup.remove(window.studioThree.gcpQaGroup);
      window.studioThree.gcpQaGroup = null;
    }
  }

  /**
   * Renders 3D Studio Three.js GCP Target Reticles, TBM Diamond Badges, and
   * 3D Error Vector Arrows (THREE.ArrowHelper) with user-selectable exaggeration scale.
   */
  function renderEnhancedGcpQaMarkers3D(points, options = {}) {
    if (!window.studioThree || !window.studioThree.overlayGroup || !Array.isArray(points)) return;
    clearEnhancedGcpQaMarkers3D();

    const THREE = window.THREE;
    if (!THREE) return;

    const grp = new THREE.Group();
    grp.name = "gs_gcp_qa_overlay_group";
    window.studioThree.gcpQaGroup = grp;
    window.studioThree.overlayGroup.add(grp);

    const scale = Number(options.exaggerationScale || (window.STATE && window.STATE.gcpVectorExaggeration) || 20);
    const centerE = (window.STATE && window.STATE.centerE) || 0;
    const centerN = (window.STATE && window.STATE.centerN) || 0;
    const centerH = (window.STATE && window.STATE.centerH) || 0;

    points.forEach((p) => {
      // Local position resolution
      let lx = 0, ly = 0, lz = 0;
      if (Array.isArray(p.local) && p.local.length >= 3) {
        lx = Number(p.local[0]) || 0;
        ly = Number(p.local[1]) || 0;
        lz = Number(p.local[2]) || 0;
      } else {
        const pe = Number(p.e_scan !== undefined ? p.e_scan : p.e) || 0;
        const pn = Number(p.n_scan !== undefined ? p.n_scan : p.n) || 0;
        const ph = Number(p.h_scan !== undefined ? p.h_scan : (p.h_gcp || 0)) || 0;
        lx = pe - centerE;
        ly = ph - centerH;
        lz = centerN - pn;
      }

      const isTbm = Boolean(p.is_tbm);
      const status = String(p.status || "pass").toLowerCase();
      const colHex = isTbm
        ? 0x0284c7 // Cyan for TBM Benchmark
        : status === "pass"
        ? 0x10b981 // Emerald for Grade A / Pass
        : status === "warn"
        ? 0xf59e0b // Amber for Warn
        : 0xef4444; // Red for Outlier

      // 1. Ground Target Reticle (Horizontal Ring)
      const ringGeom = new THREE.RingGeometry(0.35, 0.65, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: colHex,
        side: THREE.DoubleSide,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      });
      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.set(lx, ly + 0.05, lz);
      ringMesh.renderOrder = 998;
      grp.add(ringMesh);

      // If TBM benchmark: add distinctive concentric outer diamond badge
      if (isTbm) {
        const diamondGeom = new THREE.RingGeometry(0.75, 0.95, 4);
        const diamondMat = new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
          depthTest: false,
        });
        const diamondMesh = new THREE.Mesh(diamondGeom, diamondMat);
        diamondMesh.rotation.x = -Math.PI / 2;
        diamondMesh.rotation.z = Math.PI / 4;
        diamondMesh.position.set(lx, ly + 0.06, lz);
        diamondMesh.renderOrder = 999;
        grp.add(diamondMesh);
      }

      // 2. 3D Residual Error Vector (ArrowHelper)
      // dx = Easting Error = E_scan - E_gcp = dE
      // dy = Elevation Error = H_scan - H_gcp = dH
      // dz = -Northing Error = -(N_scan - N_gcp) = -dN
      const de = Number(p.de !== undefined ? p.de : p.de_m) || 0;
      const dn = Number(p.dn !== undefined ? p.dn : p.dn_m) || 0;
      const dh = Number(p.dh !== undefined ? p.dh : (p.dz_m !== undefined ? p.dz_m : 0)) || 0;

      const dx = de;
      const dy = dh;
      const dz = -dn;
      const length3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (length3D >= 0.0005) {
        const dir = new THREE.Vector3(dx / length3D, dy / length3D, dz / length3D);
        const origin = new THREE.Vector3(lx, ly + 0.08, lz);
        const lengthVis = Math.max(0.2, length3D * scale);
        const headLen = Math.min(lengthVis * 0.35, 0.45);
        const headWidth = Math.min(lengthVis * 0.18, 0.22);

        const arrow = new THREE.ArrowHelper(dir, origin, lengthVis, colHex, headLen, headWidth);
        if (arrow.line && arrow.line.material) arrow.line.material.depthTest = false;
        if (arrow.cone && arrow.cone.material) arrow.cone.material.depthTest = false;
        arrow.renderOrder = 999;
        grp.add(arrow);
      }
    });

    if (window.studioThree && typeof window.studioThree.render === "function") {
      window.studioThree.render();
    }
  }

  /**
   * Parses flexible CSV or text table input for 3D GCP accuracy QA evaluation.
   */
  function parseEnhancedGcpCsvInput(csvText) {
    const lines = String(csvText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const pts = [];
    lines.forEach((line, idx) => {
      const parts = line.split(/[,\t;]+/).map((s) => s.trim());
      if (parts.length < 3) return;

      // Skip header lines (e.g. "Name, E, N, H")
      if (idx === 0 && (isNaN(Number(parts[1])) || isNaN(Number(parts[2])))) return;

      let name = `CP-${String(idx + 1).padStart(2, "0")}`;
      let e = 0, n = 0, h_gcp = 0;
      let mesh_e = null, mesh_n = null, mesh_h = null;
      let is_tbm = false;

      if (isNaN(Number(parts[0]))) {
        name = parts[0];
        e = Number(parts[1]);
        n = Number(parts[2]);
        h_gcp = Number(parts[3]);
        if (parts.length >= 7) {
          mesh_e = Number(parts[4]);
          mesh_n = Number(parts[5]);
          mesh_h = Number(parts[6]);
        }
        if (parts.length >= 8) {
          is_tbm = /^(tbm|true|1|yes)$/i.test(parts[7]);
        } else if (parts.length === 5) {
          is_tbm = /^(tbm|true|1|yes)$/i.test(parts[4]);
        }
      } else {
        e = Number(parts[0]);
        n = Number(parts[1]);
        h_gcp = Number(parts[2]);
        if (parts.length >= 4) {
          is_tbm = /^(tbm|true|1|yes)$/i.test(parts[3]);
        }
      }

      if (Number.isFinite(e) && Number.isFinite(n) && Number.isFinite(h_gcp)) {
        const item = { name, e, n, h_gcp, is_tbm };
        if (Number.isFinite(mesh_e) && Number.isFinite(mesh_n) && Number.isFinite(mesh_h)) {
          item.mesh_e = mesh_e;
          item.mesh_n = mesh_n;
          item.mesh_h = mesh_h;
          item.h_scan = mesh_h;
        }
        pts.push(item);
      }
    });

    return pts;
  }

  /**
   * Invokes backend /api/survey/gcp-qa evaluation endpoint.
   */
  async function runEnhancedGcpAccuracyQaEvaluation(pointsInput = [], options = {}) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    try {
      const activeScanId = window.STATE ? window.STATE.activeScanId : "";
      if (!activeScanId) {
        if (typeof showToast === "function") showToast(t("請先選擇工區 3D 成果", "Please select a 3D scan first"));
        return;
      }

      const payload = {
        scan_id: activeScanId,
        apply_tbm_calibration: Boolean(options.apply_tbm_calibration),
        selected_tbm_id: options.selected_tbm_id || "",
        reset_calibration: Boolean(options.reset_calibration),
      };
      if (Array.isArray(pointsInput) && pointsInput.length > 0) {
        payload.points = pointsInput;
      } else {
        payload.generate_sample_points = true;
      }

      if (typeof apiPost !== "function") return;
      const res = await apiPost("/api/survey/gcp-qa", payload);

      if (window.STATE) {
        window.STATE.lastGcpQaResult = res;
      }

      const ptsToRender = res.gcp_residuals || res.points || [];
      renderEnhancedGcpQaMarkers3D(ptsToRender, {
        exaggerationScale: (window.STATE && window.STATE.gcpVectorExaggeration) || 20,
      });

      openEnhancedGcpAccuracyQaInspector(res);

      if (options.apply_tbm_calibration && typeof showToast === "function") {
        if (options.reset_calibration) {
          showToast(t("✓ 已復原 TBM 高程校正", "✓ Restored original vertical datum"));
        } else {
          showToast(t(`✓ 已成功套用 TBM 高程校正 (${res.tbm_shift_m >= 0 ? "+" : ""}${res.tbm_shift_m} m)`, `✓ Applied TBM datum shift (${res.tbm_shift_m} m)`));
        }
      }
    } catch (err) {
      if (typeof showToast === "function") {
        showToast(`GCP QA Error: ${err.message || err}`);
      }
    }
  }

  /**
   * Handles 3D picking when user clicks in Three.js Studio mode with GCP tool active.
   */
  function handleEnhancedGcpQa3DPick(pt, twd) {
    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const txtEl = document.getElementById("txtGcpCsvInput");
    if (!txtEl) return;

    const lines = txtEl.value.trim() ? txtEl.value.trim().split(/\r?\n/) : [];
    const nextIdx = lines.length + 1;
    const simGcpH = (Number(twd.h) - 0.015).toFixed(3);
    const newRow = `CP-${String(nextIdx).padStart(2, "0")}, ${Number(twd.e).toFixed(3)}, ${Number(twd.n).toFixed(3)}, ${simGcpH}`;
    lines.push(newRow);
    txtEl.value = lines.join("\n");

    if (typeof showToast === "function") {
      showToast(t(`已新增檢核點 CP-${String(nextIdx).padStart(2, "0")} 至檢核表`, `Added Check Point CP-${String(nextIdx).padStart(2, "0")} from 3D scan`));
    }

    runEnhancedGcpAccuracyQaEvaluation(parseEnhancedGcpCsvInput(txtEl.value));
  }

  /**
   * Generates and downloads a civil engineering 3D residual CSV with UTF-8 BOM.
   */
  function exportGcpQaCsv(qaResult) {
    if (!qaResult) return;
    const resList = qaResult.gcp_residuals || qaResult.points || [];

    let csvContent = "\ufeff"; // UTF-8 BOM
    csvContent += "Point_ID,TWD97_E_GCP_m,TWD97_N_GCP_m,TWVD2001_H_GCP_m,Scan_E_m,Scan_N_m,Scan_H_m,dE_cm,dN_cm,dH_cm,d2D_cm,d3D_cm,Is_TBM,QA_Status\r\n";

    resList.forEach((p) => {
      const name = p.name || p.id || "";
      const eg = Number(p.e_gcp !== undefined ? p.e_gcp : p.e).toFixed(3);
      const ng = Number(p.n_gcp !== undefined ? p.n_gcp : p.n).toFixed(3);
      const hg = Number(p.h_gcp).toFixed(3);
      const es = Number(p.e_scan !== undefined ? p.e_scan : p.e).toFixed(3);
      const ns = Number(p.n_scan !== undefined ? p.n_scan : p.n).toFixed(3);
      const hs = Number(p.h_scan).toFixed(3);
      const de = Number(p.de_cm !== undefined ? p.de_cm : (p.de * 100)).toFixed(1);
      const dn = Number(p.dn_cm !== undefined ? p.dn_cm : (p.dn * 100)).toFixed(1);
      const dh = Number(p.dh_cm !== undefined ? p.dh_cm : (p.dz_cm !== undefined ? p.dz_cm : (p.dh * 100))).toFixed(1);
      const d2d = Number(p.d2d_cm !== undefined ? p.d2d_cm : (p.d2d * 100)).toFixed(1);
      const d3d = Number(p.d3d_cm !== undefined ? p.d3d_cm : (p.d3d * 100)).toFixed(1);
      const isTbm = p.is_tbm ? "YES" : "NO";
      const status = String(p.status || "PASS").toUpperCase();

      csvContent += `${name},${eg},${ng},${hg},${es},${ns},${hs},${de},${dn},${dh},${d2d},${d3d},${isTbm},${status}\r\n`;
    });

    csvContent += "\r\n";
    csvContent += "Metric,Value_m,Value_cm,Description\r\n";
    csvContent += `RMSE_3D,${Number(qaResult.rmse_3d_m || qaResult.rmse_3d || 0).toFixed(4)},${Number(qaResult.rmse_3d_cm || (qaResult.rmse_3d * 100) || 0).toFixed(2)},True 3D Spatial RMSE\r\n`;
    csvContent += `RMSE_2D,${Number(qaResult.rmse_2d_m || qaResult.rmse_2d || 0).toFixed(4)},${Number(qaResult.rmse_2d_cm || (qaResult.rmse_2d * 100) || 0).toFixed(2)},Planar Horizontal RMSE\r\n`;
    csvContent += `RMSE_H,${Number(qaResult.rmse_h_m || qaResult.rmse_h || qaResult.rmse_z_m || 0).toFixed(4)},${Number(qaResult.rmse_h_cm || qaResult.rmse_z_cm || 0).toFixed(2)},Vertical Elevation RMSE\r\n`;
    csvContent += `ASPRS_95_Vertical,${Number(qaResult.accuracy_z_95_m || qaResult.confidence_95_m || 0).toFixed(4)},${Number((qaResult.accuracy_z_95_m || qaResult.confidence_95_m || 0) * 100).toFixed(2)},1.9600 x RMSE_H\r\n`;
    csvContent += `ASPRS_95_Horizontal,${Number(qaResult.accuracy_r_95_m || qaResult.confidence_95_2d_m || 0).toFixed(4)},${Number((qaResult.accuracy_r_95_m || qaResult.confidence_95_2d_m || 0) * 100).toFixed(2)},1.7308 x RMSE_2D\r\n`;
    csvContent += `TBM_Calibration_Shift_m,${Number(qaResult.tbm_shift_m || 0).toFixed(4)},${Number((qaResult.tbm_shift_m || 0) * 100).toFixed(2)},Applied: ${qaResult.tbm_applied ? "YES" : "NO"}\r\n`;

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `3D_GCP_QA_${qaResult.scan_id || "scan"}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Opens the enhanced Milestone 2 3D GCP Accuracy & Control Alignment Inspector Side Panel.
   */
  function openEnhancedGcpAccuracyQaInspector(qaResult = (window.STATE && window.STATE.lastGcpQaResult)) {
    if (typeof setActiveStudioTool === "function") setActiveStudioTool("gcp_qa");
    if (window.STATE) window.STATE.sidePanelMinimized = false;

    const t = typeof tr === "function" ? tr : (zh, en) => zh;
    const esc = typeof escapeHtml === "function" ? escapeHtml : (s) => String(s);

    if (!qaResult || (window.STATE && qaResult.scan_id !== window.STATE.activeScanId)) {
      runEnhancedGcpAccuracyQaEvaluation([]);
      return;
    }

    const resList = qaResult.gcp_residuals || qaResult.points || [];
    const grade = qaResult.qa_grade || "A";
    const gradeClass = grade === "A" ? "grade-a" : grade === "B" ? "grade-b" : "grade-c";

    const rmse3dCm = Number(qaResult.rmse_3d_cm || (qaResult.rmse_3d * 100) || 0).toFixed(2);
    const rmse2dCm = Number(qaResult.rmse_2d_cm || (qaResult.rmse_2d * 100) || 0).toFixed(2);
    const rmseHCm = Number(qaResult.rmse_h_cm || qaResult.rmse_z_cm || (qaResult.rmse_h * 100) || 0).toFixed(2);
    const asprsVertCm = Number((qaResult.accuracy_z_95_m || qaResult.confidence_95_m || 0) * 100).toFixed(2);
    const asprsHorizCm = Number((qaResult.accuracy_r_95_m || qaResult.confidence_95_2d_m || 0) * 100).toFixed(2);
    const biasHCm = Number((qaResult.mean_bias_h !== undefined ? qaResult.mean_bias_h : (qaResult.mean_error_m || 0)) * 100).toFixed(2);

    const prev = qaResult.tbm_calibration_preview || {};
    const proposedShiftM = Number(prev.shift_m !== undefined ? prev.shift_m : (qaResult.tbm_shift_m || 0)).toFixed(3);
    const proposedShiftCm = (proposedShiftM * 100).toFixed(1);
    const calRmseHCm = Number(prev.calibrated_rmse_h_cm || (prev.calibrated_rmse_h_m ? prev.calibrated_rmse_h_m * 100 : rmseHCm)).toFixed(2);
    const isCalibrated = Boolean(qaResult.tbm_applied);

    const csvDefault = resList
      .map((p) => {
        const eg = Number(p.e_gcp !== undefined ? p.e_gcp : p.e).toFixed(3);
        const ng = Number(p.n_gcp !== undefined ? p.n_gcp : p.n).toFixed(3);
        const hg = Number(p.h_gcp).toFixed(3);
        return `${p.name}, ${eg}, ${ng}, ${hg}${p.is_tbm ? ", TBM" : ""}`;
      })
      .join("\n");

    const tableRowsHtml = resList
      .map((p, idx) => {
        const status = String(p.status || "pass").toLowerCase();
        const badgeClass = status === "pass" ? "pass" : status === "warn" ? "warn" : "outlier";
        const isTbm = Boolean(p.is_tbm);
        const deCm = Number(p.de_cm !== undefined ? p.de_cm : (p.de * 100)).toFixed(1);
        const dnCm = Number(p.dn_cm !== undefined ? p.dn_cm : (p.dn * 100)).toFixed(1);
        const dhCm = Number(p.dh_cm !== undefined ? p.dh_cm : (p.dz_cm !== undefined ? p.dz_cm : (p.dh * 100))).toFixed(1);
        const d3dCm = Number(p.d3d_cm !== undefined ? p.d3d_cm : (p.d3d * 100)).toFixed(1);

        return `
          <tr data-point-id="${esc(p.name)}">
            <td>
              <input type="radio" name="gcpTbmRadio" value="${esc(p.name)}" ${isTbm ? "checked" : ""} title="${t("設為高程水準基點 (TBM)", "Set as TBM benchmark")}" />
            </td>
            <td style="font-weight:700;color:${isTbm ? "var(--ui-accent, #38bdf8)" : "inherit"};">
              ${esc(p.name)} ${isTbm ? "⚓" : ""}
            </td>
            <td>${Number(p.h_gcp).toFixed(3)}</td>
            <td>${Number(p.h_scan).toFixed(3)}</td>
            <td style="color:${deCm >= 0 ? "inherit" : "#f43f5e"};">${deCm >= 0 ? "+" : ""}${deCm}</td>
            <td style="color:${dnCm >= 0 ? "inherit" : "#f43f5e"};">${dnCm >= 0 ? "+" : ""}${dnCm}</td>
            <td style="font-weight:700;color:${status === "pass" ? "#10b981" : status === "warn" ? "#f59e0b" : "#ef4444"};">
              ${dhCm >= 0 ? "+" : ""}${dhCm}
            </td>
            <td style="font-weight:700;">${d3dCm}</td>
            <td><span class="gcp-status-badge ${badgeClass}">${esc(status.toUpperCase())}</span></td>
          </tr>
        `;
      })
      .join("");

    const currentScale = (window.STATE && window.STATE.gcpVectorExaggeration) || 20;

    const panelHtml = `
      <div class="gcp-qa-container">
        <!-- Grade Header -->
        <div class="gcp-grade-header">
          <div>
            <div style="font-weight:700;font-size:12px;color:var(--ui-text-primary, #f1f5f9);">
              🎯 ${t("3D 控制點空間精度檢核", "3D Control Point Accuracy QA")}
            </div>
            <div style="font-size:10px;color:var(--ui-text-secondary, #94a3b8);margin-top:2px;">
              CRS: <b>${esc(qaResult.crs || "TWD97 [121] + TWVD2001")}</b> | N = ${resList.length} 點
            </div>
          </div>
          <span class="gcp-grade-badge ${gradeClass}">
            Grade ${esc(grade)} (${rmse3dCm} cm)
          </span>
        </div>

        <!-- 3D KPI Metrics Cards -->
        <div class="gcp-kpi-grid">
          <div class="gcp-kpi-card highlight">
            <div class="kpi-label">3D 空間 RMSE</div>
            <div class="kpi-val">${rmse3dCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">平面 2D RMSE</div>
            <div class="kpi-val">${rmse2dCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">高程 RMSE_H</div>
            <div class="kpi-val" style="color:${grade === "A" ? "#10b981" : grade === "B" ? "#f59e0b" : "#ef4444"};">
              ${rmseHCm} <span style="font-size:10px;font-weight:600;">cm</span>
            </div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">ASPRS 95% 高程</div>
            <div class="kpi-val">±${asprsVertCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">ASPRS 95% 平面</div>
            <div class="kpi-val">±${asprsHorizCm} <span style="font-size:10px;font-weight:600;">cm</span></div>
          </div>
          <div class="gcp-kpi-card">
            <div class="kpi-label">高程平均偏差</div>
            <div class="kpi-val" style="color:${biasHCm >= 0 ? "inherit" : "#f43f5e"};">
              ${biasHCm >= 0 ? "+" : ""}${biasHCm} <span style="font-size:10px;font-weight:600;">cm</span>
            </div>
          </div>
        </div>

        <!-- 1-Click TBM Vertical Datum Calibration Card -->
        <div class="gcp-tbm-card">
          <div class="gcp-tbm-header">
            <span class="gcp-tbm-title">
              ⚓ ${t("1-Click TBM 水準基點高程校正", "1-Click TBM Vertical Datum Calibration")}
            </span>
            ${isCalibrated ? `<span style="font-size:9.5px;padding:2px 7px;border-radius:4px;background:rgba(16,185,129,0.18);color:#10b981;font-weight:700;">✓ 已校正 (${qaResult.tbm_shift_m >= 0 ? "+" : ""}${qaResult.tbm_shift_m}m)</span>` : ""}
          </div>
          <div class="gcp-tbm-preview-box">
            <div class="gcp-tbm-preview-row">
              <span style="color:var(--ui-text-secondary, #94a3b8);">${t("校正基準模式：", "Calibration Mode:")}</span>
              <b>${prev.tbm_point_id ? `指定水準點 [${esc(prev.tbm_point_id)}]` : t("全區平均偏差補償 (Network Mean)", "Network Mean Bias")}</b>
            </div>
            <div class="gcp-tbm-preview-row" style="margin-top:3px;">
              <span style="color:var(--ui-text-secondary, #94a3b8);">${t("建議高程平移量：", "Proposed Shift ΔH:")}</span>
              <b style="color:var(--ui-accent, #38bdf8);">${proposedShiftM >= 0 ? "+" : ""}${proposedShiftM} m (${proposedShiftCm >= 0 ? "+" : ""}${proposedShiftCm} cm)</b>
            </div>
            <div class="gcp-tbm-preview-row" style="margin-top:3px;">
              <span style="color:var(--ui-text-secondary, #94a3b8);">${t("校正後預估高程 RMSE：", "Calibrated RMSE_H Preview:")}</span>
              <span style="color:#10b981;font-weight:800;">${calRmseHCm} cm (當前 ${rmseHCm} cm)</span>
            </div>
          </div>
          <div class="gcp-tbm-actions">
            <button type="button" class="btn-xs primary" id="btnApplyTbmCalibration" style="flex:1;justify-content:center;">
              ⚡ ${t("套用 TBM 高程校正", "Apply TBM Calibration")}
            </button>
            ${isCalibrated ? `
              <button type="button" class="btn-xs" id="btnResetTbmCalibration" title="${t("復原原始測量水準高程", "Restore original datum")}">
                ↺ ${t("復原", "Reset")}
              </button>
            ` : ""}
          </div>
          <div style="font-size:9.5px;color:var(--ui-text-secondary, #94a3b8);margin-top:4px;">
            🔒 ${t("零破壞保證：原始點雲與 DSM 高程不受更動，僅於執行期套用水準基準平移", "Zero-Destruction: Raw point cloud is unmodified; applies runtime datum offset.")}
          </div>
        </div>

        <!-- Check Points CSV Input Textarea -->
        <div class="gs-form-group" style="margin-bottom:2px;">
          <label style="display:flex;justify-content:space-between;align-items:center;">
            <span>${t("檢核點座標表 (點號, E, N, H_gcp, [TBM])", "Check Points CSV (Name, E, N, H, [TBM])")}</span>
            <span style="font-size:9.5px;color:var(--ui-text-secondary, #94a3b8);">${t("可直接手動編輯或貼上", "Editable")}</span>
          </label>
          <textarea class="gs-input" id="txtGcpCsvInput" rows="3" style="font-family:var(--font-mono);font-size:10.5px;padding:5px 7px;">${esc(csvDefault)}</textarea>
        </div>

        <!-- Evaluation Action Buttons -->
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs primary" id="btnComputeGcpQa" style="flex:1;justify-content:center;">
            📊 ${t("計算 3D 空間精度", "Compute 3D QA")}
          </button>
          <button type="button" class="btn-xs" id="btnLoadSampleGcpPoints" title="${t("自動在工區分佈 6 處標準檢核點", "Auto-Generate 6 Site Check Points")}">
            🎯 ${t("自動佈點", "Auto GCPs")}
          </button>
        </div>

        <!-- 3D Residuals Table -->
        <div class="gcp-table-container">
          <table class="gcp-residuals-table">
            <thead>
              <tr>
                <th style="width:24px;">TBM</th>
                <th>ID</th>
                <th>H_gcp</th>
                <th>H_scan</th>
                <th>dE</th>
                <th>dN</th>
                <th>dH (cm)</th>
                <th>d3D (cm)</th>
                <th style="width:40px;">Status</th>
              </tr>
            </thead>
            <tbody>${tableRowsHtml}</tbody>
          </table>
        </div>

        <!-- 3D Studio Vector Exaggeration Controls -->
        <div class="gcp-vis-controls">
          <span>📐 ${t("3D 誤差向量可視化：", "3D Error Vectors:")}</span>
          <div class="gcp-scale-selector">
            <label>${t("放大倍率：", "Scale:")}</label>
            <select id="selGcpVectorScale">
              <option value="1" ${currentScale === 1 ? "selected" : ""}>1x (真實比例)</option>
              <option value="10" ${currentScale === 10 ? "selected" : ""}>10x</option>
              <option value="20" ${currentScale === 20 ? "selected" : ""}>20x (建議視圖)</option>
              <option value="50" ${currentScale === 50 ? "selected" : ""}>50x</option>
              <option value="100" ${currentScale === 100 ? "selected" : ""}>100x</option>
            </select>
          </div>
        </div>

        <!-- Export Buttons -->
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs" id="btnDownloadGcpCsv" style="flex:1;justify-content:center;">
            💾 ${t("下載 3D 殘差 CSV", "Download 3D CSV")}
          </button>
          <a class="btn-xs primary" href="${esc(typeof appendAuthToDownloadUrl === "function" ? appendAuthToDownloadUrl(qaResult.html_url || "#") : (qaResult.html_url || "#"))}" target="_blank" rel="noopener" style="flex:1;justify-content:center;text-decoration:none;display:flex;align-items:center;">
            📄 ${t("品管證書", "Certificate")}
          </a>
          <button type="button" class="btn-xs" id="btnPrintGcpCertificate" title="${t("列印檢核單 (Ctrl+P)", "Print Report")}">
            🖨️
          </button>
        </div>
      </div>
    `;

    if (typeof showSidePanel === "function") {
      showSidePanel(
        `<span>${t("🎯 控制點精度檢核與 3D GCP 校正", "3D Control Alignment & GCP QA")}</span>`,
        panelHtml
      );
    }

    // Bind Event Listeners
    document.getElementById("btnComputeGcpQa")?.addEventListener("click", () => {
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseEnhancedGcpCsvInput(txt);
      runEnhancedGcpAccuracyQaEvaluation(parsed);
    });

    document.getElementById("btnLoadSampleGcpPoints")?.addEventListener("click", () => {
      runEnhancedGcpAccuracyQaEvaluation([]);
    });

    document.getElementById("btnApplyTbmCalibration")?.addEventListener("click", () => {
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseEnhancedGcpCsvInput(txt);
      const selectedTbm = document.querySelector('input[name="gcpTbmRadio"]:checked')?.value || "";
      runEnhancedGcpAccuracyQaEvaluation(parsed, {
        apply_tbm_calibration: true,
        selected_tbm_id: selectedTbm,
      });
    });

    document.getElementById("btnResetTbmCalibration")?.addEventListener("click", () => {
      const txt = document.getElementById("txtGcpCsvInput")?.value || "";
      const parsed = parseEnhancedGcpCsvInput(txt);
      runEnhancedGcpAccuracyQaEvaluation(parsed, {
        apply_tbm_calibration: true,
        reset_calibration: true,
      });
    });

    document.querySelectorAll('input[name="gcpTbmRadio"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const val = e.target.value;
        const txt = document.getElementById("txtGcpCsvInput")?.value || "";
        const parsed = parseEnhancedGcpCsvInput(txt);
        runEnhancedGcpAccuracyQaEvaluation(parsed, { selected_tbm_id: val });
      });
    });

    document.getElementById("selGcpVectorScale")?.addEventListener("change", (e) => {
      const scaleVal = Number(e.target.value) || 20;
      if (window.STATE) window.STATE.gcpVectorExaggeration = scaleVal;
      const ptsToRender = qaResult.gcp_residuals || qaResult.points || [];
      renderEnhancedGcpQaMarkers3D(ptsToRender, { exaggerationScale: scaleVal });
    });

    document.getElementById("btnDownloadGcpCsv")?.addEventListener("click", () => {
      exportGcpQaCsv(qaResult);
    });

    document.getElementById("btnPrintGcpCertificate")?.addEventListener("click", () => {
      window.print();
    });
  }

  // Global overrides & hook bindings
  window.renderEarthworkInputFieldsHtml = renderEarthworkInputFieldsHtml;
  window.getEarthworkInputValues = getEarthworkInputValues;
  window.renderMassConservationScheduleHtml = renderMassConservationScheduleHtml;
  window.safeParseFloat = safeParseFloat;

  window.openGcpAccuracyQaInspector = openEnhancedGcpAccuracyQaInspector;
  window.handleGcpQa3DPick = handleEnhancedGcpQa3DPick;
  window.renderGcpQaMarkers3D = renderEnhancedGcpQaMarkers3D;
  window.clearGcpQaMarkers3D = clearEnhancedGcpQaMarkers3D;
  window.runGcpAccuracyQaEvaluation = runEnhancedGcpAccuracyQaEvaluation;
  window.parseGcpCsvInput = parseEnhancedGcpCsvInput;
  window.exportGcpQaCsv = exportGcpQaCsv;

  // Auto-launch GCP QA Inspector if ?tool=gcp_qa or ?inspect=gcp_qa is present in URL
  if (typeof window !== "undefined" && window.location) {
    try {
      const qParams = new URLSearchParams(window.location.search);
      if (qParams.get("tool") === "gcp_qa" || qParams.get("inspect") === "gcp_qa") {
        const timer = setInterval(() => {
          if (window.STATE && window.STATE.activeScanId && window.studioThree && window.studioThree.scene) {
            clearInterval(timer);
            setTimeout(() => {
              openEnhancedGcpAccuracyQaInspector();
            }, 800);
          }
        }, 400);
        setTimeout(() => clearInterval(timer), 25000);
      }
    } catch (_) {}
  }
})();

