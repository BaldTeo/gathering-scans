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

  // Export functions to global scope
  window.renderEarthworkInputFieldsHtml = renderEarthworkInputFieldsHtml;
  window.getEarthworkInputValues = getEarthworkInputValues;
  window.renderMassConservationScheduleHtml = renderMassConservationScheduleHtml;
  window.safeParseFloat = safeParseFloat;
})();
