#!/usr/bin/env python3
"""
Civil Surveying & Computational Geometry Engine for GatheringScans (Facade)
All calculations and CAD exports operate in TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904]:
1. Cut/Fill Volume & Material Stockpile Tonnage Calculator (pc_worker/surveying/dsm_and_volume.py)
2. Marching Squares Contours, AutoCAD .DXF/.DWG, A3 PDF, Profile & RTK Photos (pc_worker/surveying/contours_and_cad.py)
3. Textured Mesh Loader, Gemini VLM & Categorization Cache/Overrides (pc_worker/surveying/categorization_io.py)
4. 3D Tree, Wall, Road & Water Heuristics and Deliverables (pc_worker/surveying/categorization_heuristics.py)
"""

from __future__ import annotations

from pc_worker.surveying import (
    wgs84_to_twd97,
    GLTFPACK_EXE,
    MS_CASES,
    polygon_area_and_perimeter_2d,
    point_in_polygon_2d,
    simplify_polyline_2d,
    DsmAndVolumeMixin,
    ContoursAndCadMixin,
    CategorizationIoMixin,
    CategorizationHeuristicsMixin,
)


class SurveyingEngine(
    DsmAndVolumeMixin,
    ContoursAndCadMixin,
    CategorizationIoMixin,
    CategorizationHeuristicsMixin,
):
    """Unified Civil Surveying Engine composed of modular domain mixins (< 2,600 lines each)."""

    pass


__all__ = [
    "SurveyingEngine",
    "wgs84_to_twd97",
    "GLTFPACK_EXE",
    "MS_CASES",
    "polygon_area_and_perimeter_2d",
    "point_in_polygon_2d",
    "simplify_polyline_2d",
]
