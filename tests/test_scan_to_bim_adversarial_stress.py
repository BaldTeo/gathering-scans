#!/usr/bin/env python3
"""
Adversarial Stress Test Suite for Milestone 6 Scan-to-BIM.
Tests degenerate geometries, edge cases, mesh topology, signed volume, and API robustness.
"""

import math
import unittest
import tempfile
import os
import sys
from typing import List, Tuple, Dict, Any

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.surveying.scan_to_bim import (
    _generate_cylinder_mesh,
    _generate_ellipsoid_mesh,
    _generate_box_mesh,
    _generate_extruded_polygon_mesh,
    _generate_extruded_wall_prism_mesh,
    _generate_pipe_cylinder_mesh,
    _triangulate_polygon_earclipping,
    ScanToBimMixin,
)
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.priority_queue import ScanQueueDB


def compute_mesh_signed_volume(vertices: List[Tuple[float, float, float]], faces: List[Tuple[int, int, int]]) -> float:
    total_vol = 0.0
    for a, b, c in faces:
        v0 = vertices[a]
        v1 = vertices[b]
        v2 = vertices[c]
        cx = v0[1] * v1[2] - v0[2] * v1[1]
        cy = v0[2] * v1[0] - v0[0] * v1[2]
        cz = v0[0] * v1[1] - v0[1] * v1[0]
        dot = cx * v2[0] + cy * v2[1] + cz * v2[2]
        total_vol += dot
    return total_vol / 6.0


def check_mesh_manifold_topology(vertices: List[Tuple[float, float, float]], faces: List[Tuple[int, int, int]]) -> Dict[str, Any]:
    directed_edges: Dict[Tuple[int, int], int] = {}
    undirected_edges: Dict[Tuple[int, int], int] = {}

    for f_idx, (a, b, c) in enumerate(faces):
        edges = [(a, b), (b, c), (c, a)]
        for u, v in edges:
            directed_edges[(u, v)] = directed_edges.get((u, v), 0) + 1
            u_edge = (min(u, v), max(u, v))
            undirected_edges[u_edge] = undirected_edges.get(u_edge, 0) + 1

    boundary_edges = [e for e, count in undirected_edges.items() if count != 2]
    duplicate_directed = [e for e, count in directed_edges.items() if count > 1]
    unmatched_directed = [e for e in directed_edges if (e[1], e[0]) not in directed_edges]

    V = len(vertices)
    E = len(undirected_edges)
    F = len(faces)
    euler_char = V - E + F

    return {
        "V": V,
        "E": E,
        "F": F,
        "euler": euler_char,
        "is_closed": len(boundary_edges) == 0,
        "boundary_edge_count": len(boundary_edges),
        "is_oriented_manifold": len(unmatched_directed) == 0 and len(duplicate_directed) == 0,
        "unmatched_directed_count": len(unmatched_directed),
        "duplicate_directed_count": len(duplicate_directed),
    }


class AdversarialGeometricStressTest(unittest.TestCase):
    def setUp(self):
        self.temp_db_fd, self.temp_db_path = tempfile.mkstemp(suffix=".sqlite3")
        self.db = ScanQueueDB(self.temp_db_path)
        self.scan_id = "test_adversarial_scan"
        self.db.upsert_scan({
            "scan_id": self.scan_id,
            "project_dir": tempfile.gettempdir(),
            "twd97_e": 300000.0,
            "twd97_n": 2770000.0,
            "twd97_h": 10.0,
        })
        self.survey = SurveyingEngine(self.db)

    def tearDown(self):
        try:
            os.close(self.temp_db_fd)
            if os.path.isfile(self.temp_db_path):
                os.remove(self.temp_db_path)
        except Exception:
            pass

    # -----------------------------------------------------------------------
    # Challenge 1: Wall Stress Tests
    # -----------------------------------------------------------------------
    def test_adv_wall_01_collinear_polyline(self):
        """Wall with collinear segments."""
        pts = [(0, 0, 0), (5, 0, 0), (10, 0, 0), (15, 0, 0)]
        top = [(0, 0, 2), (5, 0, 2), (10, 0, 2), (15, 0, 2)]
        mesh = _generate_extruded_wall_prism_mesh(pts, top, thickness_m=0.3)
        self.assertGreater(len(mesh["vertices"]), 0)
        self.assertGreater(len(mesh["faces"]), 0)
        topo = check_mesh_manifold_topology(mesh["vertices"], mesh["faces"])
        self.assertTrue(topo["is_closed"], f"Wall mesh not closed: {topo}")
        self.assertTrue(topo["is_oriented_manifold"], f"Wall mesh not manifold: {topo}")
        vol = compute_mesh_signed_volume(mesh["vertices"], mesh["faces"])
        self.assertGreater(vol, 0.0, f"Wall signed volume should be positive: {vol}")

    def test_adv_wall_02_negative_thickness_and_zero_height(self):
        """Wall with negative thickness and zero height."""
        pts = [(0, 0, 10), (10, 0, 10)]
        top = [(0, 0, 10), (10, 0, 10)]  # Same Z -> zero height!
        mesh = _generate_extruded_wall_prism_mesh(pts, top, thickness_m=-0.5)
        # Check thickness is clamped positively
        self.assertGreater(len(mesh["vertices"]), 0)
        # Volume with 0 height is flat (vol == 0.0)
        vol = compute_mesh_signed_volume(mesh["vertices"], mesh["faces"])
        self.assertAlmostEqual(vol, 0.0, places=4)

    def test_adv_wall_03_single_point_or_empty(self):
        """Wall with < 2 points should return empty mesh without crash."""
        mesh1 = _generate_extruded_wall_prism_mesh([(0, 0, 0)], [(0, 0, 2)], thickness_m=0.3)
        self.assertEqual(len(mesh1["vertices"]), 0)
        self.assertEqual(len(mesh1["faces"]), 0)

        mesh2 = _generate_extruded_wall_prism_mesh([], [], thickness_m=0.3)
        self.assertEqual(len(mesh2["vertices"]), 0)

    # -----------------------------------------------------------------------
    # Challenge 2: Tree Stress Tests
    # -----------------------------------------------------------------------
    def test_adv_tree_01_zero_dbh_and_zero_height(self):
        """Tree with zero DBH and zero height."""
        payload = {
            "scan_id": self.scan_id,
            "categories": ["trees"],
            "categorization_data": {
                "ok": True,
                "trees": [
                    {"id": "T_ZERO_H", "height_m": 0.0, "dbh_cm": 0.0, "trunk_twd97": [300000, 2770000, 10]},
                    {"id": "T_MIN_H", "height_m": 2.5, "dbh_cm": 0.0, "trunk_twd97": [300000, 2770000, 10]},
                ],
                "anchor_twd97": {"e": 300000, "n": 2770000, "h": 10},
            }
        }
        res = self.survey.fit_scan_to_bim_primitives(payload)
        self.assertTrue(res["ok"])
        # T_ZERO_H should be filtered out by min_tree_height
        self.assertEqual(len(res["primitives"]), 1)
        prim = res["primitives"][0]
        self.assertEqual(prim["source_id"], "T_MIN_H")
        # DBH 0.0 was gracefully defaulted/clamped to positive radius
        self.assertGreater(prim["properties"]["volume_m3"], 0.0)

    def test_adv_tree_02_negative_dimensions(self):
        """Tree with negative height/dbh in raw mesh generator."""
        cyl = _generate_cylinder_mesh((0, 0, 0), radius=-0.5, height=-2.0)
        self.assertGreater(len(cyl["vertices"]), 0)
        vol = compute_mesh_signed_volume(cyl["vertices"], cyl["faces"])
        self.assertGreater(vol, 0.0)

        ell = _generate_ellipsoid_mesh((0, 0, 0), rx=-1.0, ry=-2.0, rz=-3.0)
        self.assertGreater(len(ell["vertices"]), 0)

    # -----------------------------------------------------------------------
    # Challenge 3: Road Polygon Stress Tests
    # -----------------------------------------------------------------------
    def test_adv_road_01_non_convex_l_shape(self):
        """Road with non-convex L-shaped polygon."""
        l_shape = [
            (0.0, 0.0), (10.0, 0.0), (10.0, 4.0), (4.0, 4.0), (4.0, 10.0), (0.0, 10.0)
        ]
        tris = _triangulate_polygon_earclipping(l_shape)
        # L-shape with 6 vertices must triangulate into 6 - 2 = 4 triangles
        self.assertEqual(len(tris), 4)

        # 3D extrusion
        l_shape_3d = [(p[0], p[1], 10.0) for p in l_shape]
        mesh = _generate_extruded_polygon_mesh(l_shape_3d, extrusion_depth=0.25, extrude_direction="down")
        self.assertGreater(len(mesh["vertices"]), 0)
        self.assertGreater(len(mesh["faces"]), 0)

    def test_adv_road_02_degenerate_polygon_points(self):
        """Road with < 3 points should not crash."""
        mesh1 = _generate_extruded_polygon_mesh([(0, 0, 0), (1, 1, 0)], extrusion_depth=0.2)
        self.assertEqual(len(mesh1["vertices"]), 0)

        mesh2 = _generate_extruded_polygon_mesh([(0, 0, 0)], extrusion_depth=0.2)
        self.assertEqual(len(mesh2["vertices"]), 0)

    # -----------------------------------------------------------------------
    # Challenge 4: Water Body Stress Tests
    # -----------------------------------------------------------------------
    def test_adv_water_01_single_point_and_inverted_elevation(self):
        """Water body with 1 point and inverted/negative elevation."""
        payload = {
            "scan_id": self.scan_id,
            "categories": ["water"],
            "categorization_data": {
                "ok": True,
                "water_bodies": [
                    {
                        "id": "WB_DEGEN",
                        "water_level_twvd2001_m": -50.0,
                        "boundary_twd97": [[300000, 2770000, -50.0]],
                    },
                    {
                        "id": "WB_VALID",
                        "water_level_twvd2001_m": -5.0,
                        "planar_area_m2": 80.0,
                        "boundary_twd97": [
                            [300000, 2770000, -5.0],
                            [300020, 2770000, -5.0],
                            [300020, 2770010, -5.0],
                            [300000, 2770010, -5.0],
                        ],
                    }
                ],
                "anchor_twd97": {"e": 300000, "n": 2770000, "h": 0},
            }
        }
        res = self.survey.fit_scan_to_bim_primitives(payload)
        self.assertTrue(res["ok"])
        # WB_DEGEN (1 pt) ignored, WB_VALID processed
        self.assertEqual(len(res["primitives"]), 1)
        prim = res["primitives"][0]
        self.assertEqual(prim["source_id"], "WB_VALID")
        self.assertEqual(prim["properties"]["water_level_m"], -5.0)

    # -----------------------------------------------------------------------
    # Challenge 5: Pipe Stress Tests
    # -----------------------------------------------------------------------
    def test_adv_pipe_01_zero_length(self):
        """Pipe with start == end (zero length)."""
        mesh = _generate_pipe_cylinder_mesh((10, 10, 10), (10, 10, 10), radius=0.2)
        self.assertEqual(len(mesh["vertices"]), 0)
        self.assertEqual(len(mesh["faces"]), 0)

    def test_adv_pipe_02_vertical_pipe(self):
        """Vertical pipe (start to end parallel to Z axis)."""
        mesh = _generate_pipe_cylinder_mesh((0, 0, 0), (0, 0, 10), radius=0.25)
        self.assertGreater(len(mesh["vertices"]), 0)
        self.assertGreater(len(mesh["faces"]), 0)

    def test_adv_pipe_03_zero_and_negative_diameter(self):
        """Pipe with zero or negative diameter."""
        mesh = _generate_pipe_cylinder_mesh((0, 0, 0), (10, 0, 0), radius=-0.5)
        # Clamped to positive minimum radius
        self.assertGreater(len(mesh["vertices"]), 0)

    # -----------------------------------------------------------------------
    # Challenge 6: Exporter Stress Tests
    # -----------------------------------------------------------------------
    def test_adv_exporter_empty_and_corrupt_primitives(self):
        """Exporter with empty primitives list or corrupted primitives."""
        # Empty list
        res_empty = self.survey.export_scan_to_bim({
            "scan_id": self.scan_id,
            "primitives": [],
            "formats": ["ifc", "dxf", "obj"],
        })
        self.assertTrue(res_empty["ok"])
        self.assertEqual(res_empty["primitive_count"], 0)

        # Corrupted primitive missing mesh
        corrupt_prim = [{"id": "BAD", "category": "unknown", "mesh": {}}]
        res_corrupt = self.survey.export_scan_to_bim({
            "scan_id": self.scan_id,
            "primitives": corrupt_prim,
            "formats": ["ifc", "dxf", "obj"],
        })
        self.assertTrue(res_corrupt["ok"])


if __name__ == "__main__":
    unittest.main()
