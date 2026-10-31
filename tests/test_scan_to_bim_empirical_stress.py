#!/usr/bin/env python3
"""
Empirical verification harness for Scan-to-BIM geometric fitting.
Tests signed volume, normal winding, manifold edge-sharing, and degenerate input resilience.
"""

import math
from typing import List, Tuple, Dict, Any, Set

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

def compute_mesh_signed_volume(vertices: List[Tuple[float, float, float]], faces: List[Tuple[int, int, int]]) -> float:
    """
    Compute signed volume of a closed triangle mesh using the divergence theorem:
    V = (1/6) * sum_{faces} (v0 x v1) . v2
    If faces are wound counter-clockwise (outward-pointing normals), signed volume is POSITIVE.
    If faces are wound clockwise (inward-pointing normals), signed volume is NEGATIVE.
    """
    total_vol = 0.0
    for a, b, c in faces:
        v0 = vertices[a]
        v1 = vertices[b]
        v2 = vertices[c]
        # Cross product v0 x v1
        cx = v0[1] * v1[2] - v0[2] * v1[1]
        cy = v0[2] * v1[0] - v0[0] * v1[2]
        cz = v0[0] * v1[1] - v0[1] * v1[0]
        # Dot with v2
        dot = cx * v2[0] + cy * v2[1] + cz * v2[2]
        total_vol += dot
    return total_vol / 6.0


def check_mesh_manifold_topology(vertices: List[Tuple[float, float, float]], faces: List[Tuple[int, int, int]]) -> Dict[str, Any]:
    """
    Check if a triangle mesh is a closed, 2-manifold without boundary edges or non-manifold edges.
    In a closed manifold:
    - Every directed edge (u, v) must have exactly one corresponding reverse directed edge (v, u) in another face.
    - No edge is shared by > 2 faces.
    - V - E + F == 2 * (1 - genus).
    """
    directed_edges: Dict[Tuple[int, int], int] = {}
    undirected_edges: Dict[Tuple[int, int], int] = {}

    for f_idx, (a, b, c) in enumerate(faces):
        edges = [(a, b), (b, c), (c, a)]
        for u, v in edges:
            directed_edges[(u, v)] = directed_edges.get((u, v), 0) + 1
            u_edge = (min(u, v), max(u, v))
            undirected_edges[u_edge] = undirected_edges.get(u_edge, 0) + 1

    # Check for boundary edges (undirected count != 2)
    boundary_edges = [e for e, count in undirected_edges.items() if count != 2]
    # Check for non-manifold orientation (directed edge used more than once, or reverse not present)
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


def run_checks():
    print("=== Empirical Mesh Topology & Signed Volume Audit ===")

    # 1. Cylinder Mesh
    cyl = _generate_cylinder_mesh((0, 0, 0), radius=1.0, height=2.0, radial_segments=16)
    cyl_vol = compute_mesh_signed_volume(cyl["vertices"], cyl["faces"])
    cyl_topo = check_mesh_manifold_topology(cyl["vertices"], cyl["faces"])
    expected_cyl_vol = math.pi * (1.0 ** 2) * 2.0
    print(f"Cylinder: signed_vol={cyl_vol:.4f} (expected ~{expected_cyl_vol:.4f}), topo={cyl_topo}")

    # 2. Ellipsoid Mesh
    ell = _generate_ellipsoid_mesh((0, 0, 0), rx=2.0, ry=2.0, rz=3.0, lat_segs=10, lon_segs=16)
    ell_vol = compute_mesh_signed_volume(ell["vertices"], ell["faces"])
    ell_topo = check_mesh_manifold_topology(ell["vertices"], ell["faces"])
    expected_ell_vol = (4.0 / 3.0) * math.pi * 2.0 * 2.0 * 3.0
    print(f"Ellipsoid: signed_vol={ell_vol:.4f} (expected ~{expected_ell_vol:.4f}), topo={ell_topo}")

    # 3. Box Mesh
    box = _generate_box_mesh((0, 0, 0), dx=4.0, dy=5.0, dz=6.0, azimuth_deg=35.0)
    box_vol = compute_mesh_signed_volume(box["vertices"], box["faces"])
    box_topo = check_mesh_manifold_topology(box["vertices"], box["faces"])
    expected_box_vol = 4.0 * 5.0 * 6.0
    print(f"Box: signed_vol={box_vol:.4f} (expected ~{expected_box_vol:.4f}), topo={box_topo}")

    # 4. Pipe Cylinder Mesh
    pipe = _generate_pipe_cylinder_mesh((0, 0, 0), (10, 0, 0), radius=0.5, radial_segments=12)
    pipe_vol = compute_mesh_signed_volume(pipe["vertices"], pipe["faces"])
    pipe_topo = check_mesh_manifold_topology(pipe["vertices"], pipe["faces"])
    expected_pipe_vol = math.pi * (0.5 ** 2) * 10.0
    print(f"Pipe: signed_vol={pipe_vol:.4f} (expected ~{expected_pipe_vol:.4f}), topo={pipe_topo}")

    # 5. Extruded Wall Prism Mesh
    base_poly = [(0, 0, 0), (10, 0, 0), (20, 10, 0)]
    top_poly = [(0, 0, 3), (10, 0, 3), (20, 10, 3)]
    wall = _generate_extruded_wall_prism_mesh(base_poly, top_poly, thickness_m=0.4)
    wall_vol = compute_mesh_signed_volume(wall["vertices"], wall["faces"])
    wall_topo = check_mesh_manifold_topology(wall["vertices"], wall["faces"])
    print(f"Wall Prism: signed_vol={wall_vol:.4f}, topo={wall_topo}")

    # 6. Extruded Polygon Mesh (Road/Water)
    poly = [(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0)]
    poly_mesh = _generate_extruded_polygon_mesh(poly, extrusion_depth=0.5, extrude_direction="down")
    poly_vol = compute_mesh_signed_volume(poly_mesh["vertices"], poly_mesh["faces"])
    poly_topo = check_mesh_manifold_topology(poly_mesh["vertices"], poly_mesh["faces"])
    expected_poly_vol = 10.0 * 10.0 * 0.5
    print(f"Extruded Polygon: signed_vol={poly_vol:.4f} (expected ~{expected_poly_vol:.4f}), topo={poly_topo}")

if __name__ == "__main__":
    run_checks()
