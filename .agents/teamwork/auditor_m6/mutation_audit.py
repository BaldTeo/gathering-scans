#!/usr/bin/env python3
"""
Forensic Integrity Mutation Sensitivity Test Suite for Milestone 6
"""
import sys
import math
from pc_worker.surveying.scan_to_bim import ScanToBimMixin

class DummyEngine(ScanToBimMixin):
    pass

def run_mutation_audit():
    engine = DummyEngine()
    results = []

    # -------------------------------------------------------------
    # 1. Wall Thickness & Geometry Mutation
    # -------------------------------------------------------------
    cat_wall = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'walls': [{
            'id': 'W1',
            'length_m': 10.0,
            'mean_height_m': 3.0,
            'base_polyline_twd97': [[300000.0, 2770000.0, 20.0], [300010.0, 2770000.0, 20.0]],
            'top_polyline_twd97': [[300000.0, 2770000.0, 23.0], [300010.0, 2770000.0, 23.0]],
        }]
    }

    w_fit1 = engine.fit_scan_to_bim_primitives({
        'scan_id': 'w_test',
        'categorization_data': cat_wall,
        'wall_thickness_m': 0.20,
        'categories': ['walls'],
    })
    w1 = w_fit1['primitives'][0]
    vol1 = w1['properties']['volume_m3']
    vy1 = w1['mesh']['vertices_twd97'][0][1]

    w_fit2 = engine.fit_scan_to_bim_primitives({
        'scan_id': 'w_test',
        'categorization_data': cat_wall,
        'wall_thickness_m': 0.50,
        'categories': ['walls'],
    })
    w2 = w_fit2['primitives'][0]
    vol2 = w2['properties']['volume_m3']
    vy2 = w2['mesh']['vertices_twd97'][0][1]

    assert vol1 == 6.0, f"Expected 6.0 m3, got {vol1}"
    assert vol2 == 15.0, f"Expected 15.0 m3, got {vol2}"
    assert abs(vy2 - vy1 - 0.15) < 1e-4, f"Transverse offset failed: {vy2 - vy1} vs 0.15"

    ifc_w1 = engine._generate_pure_python_ifc_spf("w1", [w1])
    ifc_w2 = engine._generate_pure_python_ifc_spf("w2", [w2])
    dxf_w1 = engine._generate_pure_python_3d_dxf("w1", [w1])
    dxf_w2 = engine._generate_pure_python_3d_dxf("w2", [w2])
    obj_w1, _ = engine._generate_pure_python_obj_mtl("w1", [w1], "w1.mtl")
    obj_w2, _ = engine._generate_pure_python_obj_mtl("w2", [w2], "w2.mtl")

    assert ifc_w1 != ifc_w2, "IFC SPF failed to mutate with wall thickness"
    assert dxf_w1 != dxf_w2, "DXF failed to mutate with wall thickness"
    assert obj_w1 != obj_w2, "OBJ failed to mutate with wall thickness"
    results.append("Wall thickness mutation: PASS (Vol 6.0 -> 15.0 m3, IFC/DXF/OBJ sensitive)")

    # -------------------------------------------------------------
    # 2. Tree Canopy Radius & Trunk DBH Mutation
    # -------------------------------------------------------------
    cat_tree1 = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'trees': [{
            'id': 'T1',
            'height_m': 6.0,
            'dbh_cm': 20.0,
            'crown_diameter_m': 4.0,
            'trunk_twd97': [300010.0, 2770020.0, 25.0],
            'ground_elevation_m': 25.0,
        }]
    }
    cat_tree2 = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'trees': [{
            'id': 'T1',
            'height_m': 6.0,
            'dbh_cm': 40.0,
            'crown_diameter_m': 8.0,
            'trunk_twd97': [300010.0, 2770020.0, 25.0],
            'ground_elevation_m': 25.0,
        }]
    }

    t_fit1 = engine.fit_scan_to_bim_primitives({'scan_id': 't1', 'categorization_data': cat_tree1, 'categories': ['trees']})
    t_fit2 = engine.fit_scan_to_bim_primitives({'scan_id': 't2', 'categorization_data': cat_tree2, 'categories': ['trees']})
    t1 = t_fit1['primitives'][0]
    t2 = t_fit2['primitives'][0]

    t_vol1 = t1['properties']['volume_m3']
    t_vol2 = t2['properties']['volume_m3']
    t_area1 = t1['properties']['crown_area_m2']
    t_area2 = t2['properties']['crown_area_m2']

    assert t_vol2 > t_vol1 * 3.5, f"Tree volume mutation failed: {t_vol1} -> {t_vol2}"
    assert abs(t_area2 - t_area1 * 4.0) < 0.1, f"Crown area ratio failed: {t_area1} -> {t_area2}"

    ifc_t1 = engine._generate_pure_python_ifc_spf("t1", [t1])
    ifc_t2 = engine._generate_pure_python_ifc_spf("t2", [t2])
    dxf_t1 = engine._generate_pure_python_3d_dxf("t1", [t1])
    dxf_t2 = engine._generate_pure_python_3d_dxf("t2", [t2])
    obj_t1, _ = engine._generate_pure_python_obj_mtl("t1", [t1], "t1.mtl")
    obj_t2, _ = engine._generate_pure_python_obj_mtl("t2", [t2], "t2.mtl")

    assert ifc_t1 != ifc_t2, "IFC SPF failed to mutate with tree geometry"
    assert dxf_t1 != dxf_t2, "DXF failed to mutate with tree geometry"
    assert obj_t1 != obj_t2, "OBJ failed to mutate with tree geometry"
    results.append(f"Tree geometry mutation: PASS (Vol {t_vol1} -> {t_vol2} m3, Area {t_area1} -> {t_area2} m2, Exporters sensitive)")

    # -------------------------------------------------------------
    # 3. Pipe Diameter & Elevation Mutation
    # -------------------------------------------------------------
    cat_pipe1 = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'pipes': [{
            'id': 'P1',
            'start': [300000.0, 2770000.0, 18.0],
            'end': [300020.0, 2770000.0, 17.5],
            'diameter_m': 0.30,
        }]
    }
    cat_pipe2 = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'pipes': [{
            'id': 'P1',
            'start': [300000.0, 2770000.0, 18.0],
            'end': [300020.0, 2770000.0, 17.5],
            'diameter_m': 0.60,
        }]
    }

    p_fit1 = engine.fit_scan_to_bim_primitives({'scan_id': 'p1', 'categorization_data': cat_pipe1, 'categories': ['pipes']})
    p_fit2 = engine.fit_scan_to_bim_primitives({'scan_id': 'p2', 'categorization_data': cat_pipe2, 'categories': ['pipes']})
    p1 = p_fit1['primitives'][0]
    p2 = p_fit2['primitives'][0]

    p_vol1 = p1['properties']['volume_m3']
    p_vol2 = p2['properties']['volume_m3']

    # V = pi * r^2 * L. When diameter doubles, volume quadruples!
    assert abs(p_vol2 - p_vol1 * 4.0) < 0.05, f"Pipe volume quad failed: {p_vol1} -> {p_vol2}"

    ifc_p1 = engine._generate_pure_python_ifc_spf("p1", [p1])
    ifc_p2 = engine._generate_pure_python_ifc_spf("p2", [p2])
    dxf_p1 = engine._generate_pure_python_3d_dxf("p1", [p1])
    dxf_p2 = engine._generate_pure_python_3d_dxf("p2", [p2])
    obj_p1, _ = engine._generate_pure_python_obj_mtl("p1", [p1], "p1.mtl")
    obj_p2, _ = engine._generate_pure_python_obj_mtl("p2", [p2], "p2.mtl")

    assert ifc_p1 != ifc_p2, "IFC SPF failed to mutate with pipe diameter"
    assert dxf_p1 != dxf_p2, "DXF failed to mutate with pipe diameter"
    assert obj_p1 != obj_p2, "OBJ failed to mutate with pipe diameter"
    results.append(f"Pipe diameter mutation: PASS (Vol {p_vol1} -> {p_vol2} m3, 4x ratio verified, Exporters sensitive)")

    # -------------------------------------------------------------
    # 4. Building Coordinate & Footprint Mutation
    # -------------------------------------------------------------
    cat_bldg1 = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'buildings': [{
            'id': 'B1',
            'center_twd97': [300015.0, 2770015.0, 23.0],
            'dx': 10.0,
            'dy': 8.0,
            'height_m': 5.0,
        }]
    }
    cat_bldg2 = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'buildings': [{
            'id': 'B1',
            'center_twd97': [300015.0, 2770015.0, 23.0],
            'dx': 20.0,
            'dy': 16.0,
            'height_m': 5.0,
        }]
    }

    b_fit1 = engine.fit_scan_to_bim_primitives({'scan_id': 'b1', 'categorization_data': cat_bldg1, 'categories': ['buildings']})
    b_fit2 = engine.fit_scan_to_bim_primitives({'scan_id': 'b2', 'categorization_data': cat_bldg2, 'categories': ['buildings']})
    b1 = b_fit1['primitives'][0]
    b2 = b_fit2['primitives'][0]

    b_vol1 = b1['properties']['volume_m3']
    b_vol2 = b2['properties']['volume_m3']
    assert b_vol1 == 400.0, f"Expected 400.0, got {b_vol1}"
    assert b_vol2 == 1600.0, f"Expected 1600.0, got {b_vol2}"
    results.append(f"Building footprint mutation: PASS (Vol {b_vol1} -> {b_vol2} m3, 4x ratio verified)")

    # -------------------------------------------------------------
    # 5. Coordinate Translation Sensitivity (TWD97 Shift)
    # -------------------------------------------------------------
    cat_shift = {
        'ok': True,
        'anchor_twd97': {'e': 300000.0, 'n': 2770000.0, 'h': 20.0},
        'walls': [{
            'id': 'W1',
            'length_m': 10.0,
            'mean_height_m': 3.0,
            'base_polyline_twd97': [[300100.0, 2770100.0, 30.0], [300110.0, 2770100.0, 30.0]],
            'top_polyline_twd97': [[300100.0, 2770100.0, 33.0], [300110.0, 2770100.0, 33.0]],
        }]
    }
    w_shift = engine.fit_scan_to_bim_primitives({
        'scan_id': 'w_shift',
        'categorization_data': cat_shift,
        'wall_thickness_m': 0.20,
        'categories': ['walls'],
    })['primitives'][0]

    v_orig = w1['mesh']['vertices_twd97'][0]
    v_shift = w_shift['mesh']['vertices_twd97'][0]
    dE = v_shift[0] - v_orig[0]
    dN = v_shift[1] - v_orig[1]
    dH = v_shift[2] - v_orig[2]
    assert abs(dE - 100.0) < 1e-4, f"E shift expected 100.0, got {dE}"
    assert abs(dN - 100.0) < 1e-4, f"N shift expected 100.0, got {dN}"
    assert abs(dH - 10.0) < 1e-4, f"H shift expected 10.0, got {dH}"
    results.append(f"TWD97 coordinate translation: PASS (dE={dE:.1f}, dN={dN:.1f}, dH={dH:.1f})")

    for r in results:
        print(f"  [MUTATION VALIDATED] {r}")

if __name__ == "__main__":
    run_mutation_audit()
