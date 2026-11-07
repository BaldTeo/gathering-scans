use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};
use rayon::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;

const VERSION: &str = "0.1.0";

#[inline]
fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[inline]
fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

#[inline]
fn round4(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

#[inline]
fn bytes_to_f32_vec(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err(format!("f32 buffer length {} is not a multiple of 4", bytes.len()));
    }
    let n = bytes.len() / 4;
    let mut out = Vec::with_capacity(n);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(out)
}

#[inline]
fn bytes_to_f64_vec(bytes: &[u8]) -> Result<Vec<f64>, String> {
    if bytes.len() % 8 != 0 {
        return Err(format!("f64 buffer length {} is not a multiple of 8", bytes.len()));
    }
    let n = bytes.len() / 8;
    let mut out = Vec::with_capacity(n);
    for chunk in bytes.chunks_exact(8) {
        out.push(f64::from_le_bytes([
            chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7],
        ]));
    }
    Ok(out)
}

#[inline]
fn f64_slice_to_bytes(slice: &[f64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(slice.len() * 8);
    for &v in slice {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[inline]
fn f32_slice_to_bytes(slice: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(slice.len() * 4);
    for &v in slice {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[inline]
fn i32_slice_to_bytes(slice: &[i32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(slice.len() * 4);
    for &v in slice {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Ray-casting point-in-polygon test matching `point_in_polygon_2d` in `dsm_and_volume.py`.
#[inline]
fn point_in_poly(x: f64, y: f64, poly: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        let intersect = ((yi > y) != (yj > y))
            && (x < (xj - xi) * (y - yi) / ((yj - yi) + 1e-12) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Bilinearly samples elevation and local slope gradients (dz/de, dz/dn) from a row-major f32 DSM grid.
#[inline]
fn sample_dsm_grid(
    grid: &[f32],
    nx: usize,
    ny: usize,
    e_min: f64,
    n_min: f64,
    res: f64,
    easting: f64,
    northing: f64,
) -> (f64, f64, f64) {
    let fe = (easting - e_min) / res;
    let fn_ = (northing - n_min) / res;
    let max_x = ((nx.saturating_sub(1)) as f64 - 1e-5).max(0.0);
    let max_y = ((ny.saturating_sub(1)) as f64 - 1e-5).max(0.0);
    let fe_c = fe.clamp(0.0, max_x);
    let fn_c = fn_.clamp(0.0, max_y);
    let i0 = fe_c as usize;
    let j0 = fn_c as usize;
    let i1 = (i0 + 1).min(nx.saturating_sub(1));
    let j1 = (j0 + 1).min(ny.saturating_sub(1));
    let tx = fe_c - (i0 as f64);
    let ty = fn_c - (j0 as f64);

    let z00 = grid[j0 * nx + i0] as f64;
    let z10 = grid[j0 * nx + i1] as f64;
    let z01 = grid[j1 * nx + i0] as f64;
    let z11 = grid[j1 * nx + i1] as f64;

    let z0 = z00 * (1.0 - tx) + z10 * tx;
    let z1 = z01 * (1.0 - tx) + z11 * tx;
    let z_val = z0 * (1.0 - ty) + z1 * ty;

    let dz_de = ((z10 - z00) * (1.0 - ty) + (z11 - z01) * ty) / res;
    let dz_dn = ((z01 - z00) * (1.0 - tx) + (z11 - z10) * tx) / res;
    (z_val, dz_de, dz_dn)
}

// ============================================================================
// 1. Fast Parallel .OBJ and .GLB Vertex Parsers
// ============================================================================

#[pyfunction]
#[pyo3(signature = (path, offset_xyz=(0.0, 0.0, 0.0)))]
fn parse_obj_vertices_fast<'py>(
    py: Python<'py>,
    path: &str,
    offset_xyz: (f64, f64, f64),
) -> PyResult<Bound<'py, PyBytes>> {
    let raw = fs::read(path).map_err(|e| {
        pyo3::exceptions::PyIOError::new_err(format!("Failed to read OBJ file '{}': {}", path, e))
    })?;
    if raw.is_empty() {
        return Ok(PyBytes::new_bound(py, &[]));
    }

    // Split into ~1 MB chunks aligned on newline boundaries for parallel Rayon parsing
    let target_chunk = (raw.len() / rayon::current_num_threads().max(1)).max(256 * 1024);
    let mut ranges = Vec::new();
    let mut start = 0usize;
    while start < raw.len() {
        let mut end = (start + target_chunk).min(raw.len());
        while end < raw.len() && raw[end] != b'\n' {
            end += 1;
        }
        if end < raw.len() {
            end += 1;
        }
        ranges.push((start, end));
        start = end;
    }

    let (ox, oy, oz) = offset_xyz;
    let chunk_vecs: Vec<Vec<f64>> = py.allow_threads(|| {
        ranges
            .par_iter()
            .map(|&(s, e)| {
                let slice = &raw[s..e];
                let mut local_verts = Vec::new();
                for line in slice.split(|&b| b == b'\n') {
                    let trimmed = match line.iter().position(|&b| b != b' ' && b != b'\r' && b != b'\t') {
                        Some(idx) => &line[idx..],
                        None => continue,
                    };
                    if trimmed.len() >= 7 && trimmed[0] == b'v' && (trimmed[1] == b' ' || trimmed[1] == b'\t') {
                        if let Ok(s_line) = std::str::from_utf8(&trimmed[2..]) {
                            let mut it = s_line.split_whitespace();
                            if let (Some(sx), Some(sy), Some(sz)) = (it.next(), it.next(), it.next()) {
                                if let (Ok(vx), Ok(vy), Ok(vz)) = (sx.parse::<f64>(), sy.parse::<f64>(), sz.parse::<f64>()) {
                                    if vx.is_finite() && vy.is_finite() && vz.is_finite() {
                                        local_verts.push(vx + ox);
                                        local_verts.push(vy + oy);
                                        local_verts.push(vz + oz);
                                    }
                                }
                            }
                        }
                    }
                }
                local_verts
            })
            .collect()
    });

    let total_f64: usize = chunk_vecs.iter().map(|v| v.len()).sum();
    let mut out_bytes = Vec::with_capacity(total_f64 * 8);
    for vec_part in chunk_vecs {
        for val in vec_part {
            out_bytes.extend_from_slice(&val.to_le_bytes());
        }
    }
    Ok(PyBytes::new_bound(py, &out_bytes))
}

fn mat4_mul(a: &[[f64; 4]; 4], b: &[[f64; 4]; 4]) -> [[f64; 4]; 4] {
    let mut out = [[0.0f64; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            out[r][c] = a[r][0] * b[0][c]
                + a[r][1] * b[1][c]
                + a[r][2] * b[2][c]
                + a[r][3] * b[3][c];
        }
    }
    out
}

fn node_to_mat4(nd: &Value) -> [[f64; 4]; 4] {
    if let Some(mat_arr) = nd.get("matrix").and_then(|v| v.as_array()) {
        if mat_arr.len() == 16 {
            // glTF column-major 16-element array -> 4x4 row-major matrix
            let mut m = [[0.0f64; 4]; 4];
            for c in 0..4 {
                for r in 0..4 {
                    m[r][c] = mat_arr[c * 4 + r].as_f64().unwrap_or(0.0);
                }
            }
            return m;
        }
    }
    let mut sx = 1.0;
    let mut sy = 1.0;
    let mut sz = 1.0;
    if let Some(s_arr) = nd.get("scale").and_then(|v| v.as_array()) {
        if s_arr.len() >= 3 {
            sx = s_arr[0].as_f64().unwrap_or(1.0);
            sy = s_arr[1].as_f64().unwrap_or(1.0);
            sz = s_arr[2].as_f64().unwrap_or(1.0);
        }
    }
    let mut rot = [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ];
    if let Some(q_arr) = nd.get("rotation").and_then(|v| v.as_array()) {
        if q_arr.len() == 4 {
            let mut qx = q_arr[0].as_f64().unwrap_or(0.0);
            let mut qy = q_arr[1].as_f64().unwrap_or(0.0);
            let mut qz = q_arr[2].as_f64().unwrap_or(0.0);
            let mut qw = q_arr[3].as_f64().unwrap_or(1.0);
            let nq = (qx * qx + qy * qy + qz * qz + qw * qw).sqrt();
            if nq > 1e-12 {
                qx /= nq;
                qy /= nq;
                qz /= nq;
                qw /= nq;
            }
            rot = [
                [
                    1.0 - 2.0 * (qy * qy + qz * qz),
                    2.0 * (qx * qy - qw * qz),
                    2.0 * (qx * qz + qw * qy),
                ],
                [
                    2.0 * (qx * qy + qw * qz),
                    1.0 - 2.0 * (qx * qx + qz * qz),
                    2.0 * (qy * qz - qw * qx),
                ],
                [
                    2.0 * (qx * qz - qw * qy),
                    2.0 * (qy * qz + qw * qx),
                    1.0 - 2.0 * (qx * qx + qy * qy),
                ],
            ];
        }
    }
    let mut tx = 0.0;
    let mut ty = 0.0;
    let mut tz = 0.0;
    if let Some(t_arr) = nd.get("translation").and_then(|v| v.as_array()) {
        if t_arr.len() >= 3 {
            tx = t_arr[0].as_f64().unwrap_or(0.0);
            ty = t_arr[1].as_f64().unwrap_or(0.0);
            tz = t_arr[2].as_f64().unwrap_or(0.0);
        }
    }
    [
        [rot[0][0] * sx, rot[0][1] * sy, rot[0][2] * sz, tx],
        [rot[1][0] * sx, rot[1][1] * sy, rot[1][2] * sz, ty],
        [rot[2][0] * sx, rot[2][1] * sy, rot[2][2] * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn read_glb_mesh_positions(
    mesh_idx: usize,
    meshes_list: &[Value],
    acc_list: &[Value],
    bv_list: &[Value],
    blob: &[u8],
) -> Option<Vec<[f64; 3]>> {
    if mesh_idx >= meshes_list.len() {
        return None;
    }
    let prims = meshes_list[mesh_idx].get("primitives")?.as_array()?;
    let mut out_pts = Vec::new();
    for prim in prims {
        if let Some(exts) = prim.get("extensions").and_then(|v| v.as_object()) {
            if exts.contains_key("KHR_draco_mesh_compression") {
                return None;
            }
        }
        let attrs = match prim.get("attributes").and_then(|v| v.as_object()) {
            Some(a) => a,
            None => continue,
        };
        let pos_idx = match attrs.get("POSITION").and_then(|v| v.as_u64()) {
            Some(i) => i as usize,
            None => continue,
        };
        if pos_idx >= acc_list.len() {
            continue;
        }
        let pos_acc = &acc_list[pos_idx];
        if pos_acc.get("type").and_then(|v| v.as_str()) != Some("VEC3") {
            continue;
        }
        let bv_idx = match pos_acc.get("bufferView").and_then(|v| v.as_u64()) {
            Some(i) => i as usize,
            None => continue,
        };
        if bv_idx >= bv_list.len() {
            continue;
        }
        let pos_bv = &bv_list[bv_idx];
        let ctype = pos_acc.get("componentType").and_then(|v| v.as_u64()).unwrap_or(0);
        let cnt = pos_acc.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        if cnt == 0 {
            continue;
        }
        let byte_offset = (pos_bv.get("byteOffset").and_then(|v| v.as_u64()).unwrap_or(0)
            + pos_acc.get("byteOffset").and_then(|v| v.as_u64()).unwrap_or(0)) as usize;

        if ctype == 5126 {
            let stride = pos_bv.get("byteStride").and_then(|v| v.as_u64()).unwrap_or(12) as usize;
            if stride < 12 || byte_offset + (cnt - 1) * stride + 12 > blob.len() {
                return None;
            }
            out_pts.reserve(cnt);
            for k in 0..cnt {
                let off = byte_offset + k * stride;
                let x = f32::from_le_bytes([blob[off], blob[off + 1], blob[off + 2], blob[off + 3]]) as f64;
                let y = f32::from_le_bytes([blob[off + 4], blob[off + 5], blob[off + 6], blob[off + 7]]) as f64;
                let z = f32::from_le_bytes([blob[off + 8], blob[off + 9], blob[off + 10], blob[off + 11]]) as f64;
                out_pts.push([x, y, z]);
            }
        } else if ctype == 5122 || ctype == 5123 {
            let stride = pos_bv.get("byteStride").and_then(|v| v.as_u64()).unwrap_or(6) as usize;
            if stride < 6 || byte_offset + (cnt - 1) * stride + 6 > blob.len() {
                return None;
            }
            let normalized = pos_acc.get("normalized").and_then(|v| v.as_bool()).unwrap_or(false);
            let norm_div = if normalized {
                if ctype == 5122 { 32767.0 } else { 65535.0 }
            } else {
                1.0
            };
            out_pts.reserve(cnt);
            for k in 0..cnt {
                let off = byte_offset + k * stride;
                let (x, y, z) = if ctype == 5122 {
                    (
                        (i16::from_le_bytes([blob[off], blob[off + 1]]) as f64) / norm_div,
                        (i16::from_le_bytes([blob[off + 2], blob[off + 3]]) as f64) / norm_div,
                        (i16::from_le_bytes([blob[off + 4], blob[off + 5]]) as f64) / norm_div,
                    )
                } else {
                    (
                        (u16::from_le_bytes([blob[off], blob[off + 1]]) as f64) / norm_div,
                        (u16::from_le_bytes([blob[off + 2], blob[off + 3]]) as f64) / norm_div,
                        (u16::from_le_bytes([blob[off + 4], blob[off + 5]]) as f64) / norm_div,
                    )
                };
                out_pts.push([x, y, z]);
            }
        } else {
            return None;
        }
    }
    if out_pts.is_empty() {
        None
    } else {
        Some(out_pts)
    }
}

#[pyfunction]
fn extract_glb_positions_fast<'py>(
    py: Python<'py>,
    raw_bytes: &[u8],
) -> PyResult<Option<Bound<'py, PyBytes>>> {
    if raw_bytes.len() < 28 || &raw_bytes[0..4] != b"glTF" {
        return Ok(None);
    }
    let j_len = u32::from_le_bytes([raw_bytes[12], raw_bytes[13], raw_bytes[14], raw_bytes[15]]) as usize;
    if &raw_bytes[16..20] != b"JSON" {
        return Ok(None);
    }
    let b_off = 20 + j_len;
    if b_off + 8 > raw_bytes.len() {
        return Ok(None);
    }
    let b_len = u32::from_le_bytes([
        raw_bytes[b_off],
        raw_bytes[b_off + 1],
        raw_bytes[b_off + 2],
        raw_bytes[b_off + 3],
    ]) as usize;
    if &raw_bytes[b_off + 4..b_off + 8] != b"BIN\x00" || b_off + 8 + b_len > raw_bytes.len() {
        return Ok(None);
    }

    let j: Value = match serde_json::from_slice(&raw_bytes[20..20 + j_len]) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    for ext_key in ["extensionsUsed", "extensionsRequired"] {
        if let Some(arr) = j.get(ext_key).and_then(|v| v.as_array()) {
            for item in arr {
                if item.as_str() == Some("EXT_meshopt_compression") {
                    return Ok(None);
                }
            }
        }
    }

    let empty_vec = Vec::new();
    let acc_list = j.get("accessors").and_then(|v| v.as_array()).unwrap_or(&empty_vec);
    let bv_list = j.get("bufferViews").and_then(|v| v.as_array()).unwrap_or(&empty_vec);
    let meshes_list = j.get("meshes").and_then(|v| v.as_array()).unwrap_or(&empty_vec);
    let nodes_list = j.get("nodes").and_then(|v| v.as_array()).unwrap_or(&empty_vec);
    let blob = &raw_bytes[b_off + 8..b_off + 8 + b_len];

    let mut out_f64: Vec<f64> = Vec::new();
    if !nodes_list.is_empty() {
        let scenes = j.get("scenes").and_then(|v| v.as_array()).unwrap_or(&empty_vec);
        let s_idx = j.get("scene").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let root_idxs: Vec<usize> = if s_idx < scenes.len() {
            if let Some(n_arr) = scenes[s_idx].get("nodes").and_then(|v| v.as_array()) {
                if !n_arr.is_empty() {
                    n_arr.iter().filter_map(|v| v.as_u64().map(|u| u as usize)).collect()
                } else {
                    vec![0]
                }
            } else {
                vec![0]
            }
        } else {
            vec![0]
        };

        let mut stack: Vec<(usize, [[f64; 4]; 4])> = root_idxs
            .into_iter()
            .rev()
            .map(|ri| {
                (
                    ri,
                    [
                        [1.0, 0.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0, 0.0],
                        [0.0, 0.0, 1.0, 0.0],
                        [0.0, 0.0, 0.0, 1.0],
                    ],
                )
            })
            .collect();

        let mut visited_nodes = vec![false; nodes_list.len()];
        while let Some((n_idx, m_parent)) = stack.pop() {
            if n_idx >= nodes_list.len() || visited_nodes[n_idx] {
                continue;
            }
            visited_nodes[n_idx] = true;
            let nd = &nodes_list[n_idx];
            let m_cur = mat4_mul(&m_parent, &node_to_mat4(nd));
            if let Some(m_idx) = nd.get("mesh").and_then(|v| v.as_u64()) {
                let pts = match read_glb_mesh_positions(m_idx as usize, meshes_list, acc_list, bv_list, blob) {
                    Some(p) => p,
                    None => return Ok(None),
                };
                out_f64.reserve(pts.len() * 3);
                for [px, py_v, pz] in pts {
                    let wx = m_cur[0][0] * px + m_cur[0][1] * py_v + m_cur[0][2] * pz + m_cur[0][3];
                    let wy = m_cur[1][0] * px + m_cur[1][1] * py_v + m_cur[1][2] * pz + m_cur[1][3];
                    let wz = m_cur[2][0] * px + m_cur[2][1] * py_v + m_cur[2][2] * pz + m_cur[2][3];
                    out_f64.push(wx);
                    out_f64.push(wy);
                    out_f64.push(wz);
                }
            }
            if let Some(children) = nd.get("children").and_then(|v| v.as_array()) {
                for ch_v in children.iter().rev() {
                    if let Some(ci) = ch_v.as_u64() {
                        let c_idx = ci as usize;
                        if c_idx < nodes_list.len() && !visited_nodes[c_idx] {
                            stack.push((c_idx, m_cur));
                        }
                    }
                }
            }
        }
    } else {
        for mi in 0..meshes_list.len() {
            let pts = match read_glb_mesh_positions(mi, meshes_list, acc_list, bv_list, blob) {
                Some(p) => p,
                None => return Ok(None),
            };
            out_f64.reserve(pts.len() * 3);
            for [px, py_v, pz] in pts {
                out_f64.push(px);
                out_f64.push(py_v);
                out_f64.push(pz);
            }
        }
    }

    if out_f64.is_empty() {
        return Ok(None);
    }
    let raw_out = f64_slice_to_bytes(&out_f64);
    Ok(Some(PyBytes::new_bound(py, &raw_out)))
}

// ============================================================================
// 2. High-Precision Parallel 256x256 Cut/Fill & IDW Surface Integrator
// ============================================================================

#[derive(Clone)]
struct CellEval {
    gx: f64,
    gy: f64,
    z_surf: f64,
    z_base: f64,
    dz: f64,
    surf_factor: f64,
}

#[pyfunction]
#[pyo3(signature = (
    dsm_bytes,
    nx,
    ny,
    e_min,
    n_min,
    res,
    v_shift,
    poly_2d,
    perim_samples,
    base_mode,
    datum_z,
    plane_params,
    origin_enh,
    max_grid_steps=256,
    cmp_dsm_bytes=None,
    cmp_dims=None
))]
fn integrate_cut_fill_grid<'py>(
    py: Python<'py>,
    dsm_bytes: &[u8],
    nx: usize,
    ny: usize,
    e_min: f64,
    n_min: f64,
    res: f64,
    v_shift: f64,
    poly_2d: Vec<(f64, f64)>,
    perim_samples: Vec<(f64, f64, f64)>,
    base_mode: &str,
    datum_z: f64,
    plane_params: (f64, f64, f64, f64, f64),
    origin_enh: (f64, f64, f64),
    max_grid_steps: usize,
    cmp_dsm_bytes: Option<&[u8]>,
    cmp_dims: Option<(usize, usize, f64, f64, f64, f64)>,
) -> PyResult<Bound<'py, PyDict>> {
    let grid = bytes_to_f32_vec(dsm_bytes)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(e))?;
    if grid.len() != nx * ny || nx == 0 || ny == 0 {
        return Err(pyo3::exceptions::PyValueError::new_err(
            "Invalid DSM dimensions in integrate_cut_fill_grid",
        ));
    }

    let cmp_grid_opt: Option<(Vec<f32>, usize, usize, f64, f64, f64, f64)> =
        match (cmp_dsm_bytes, cmp_dims) {
            (Some(cb), Some((cnx, cny, ce_min, cn_min, cres, cshift))) => {
                let cg = bytes_to_f32_vec(cb)
                    .map_err(|e| pyo3::exceptions::PyValueError::new_err(e))?;
                if cg.len() == cnx * cny && cnx > 0 && cny > 0 {
                    Some((cg, cnx, cny, ce_min, cn_min, cres, cshift))
                } else {
                    None
                }
            }
            _ => None,
        };

    let min_e = poly_2d.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let max_e = poly_2d.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let min_n = poly_2d.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_n = poly_2d.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);

    let span_box_e = (max_e - min_e).max(0.25);
    let span_box_n = (max_n - min_n).max(0.25);
    let eff_res = res.max(0.08);
    let cap_steps = max_grid_steps.clamp(28, 512);
    let nx_steps = ((span_box_e / eff_res).ceil() as usize).clamp(28, cap_steps);
    let ny_steps = ((span_box_n / eff_res).ceil() as usize).clamp(28, cap_steps);
    let dx_step = span_box_e / (nx_steps as f64);
    let dy_step = span_box_n / (ny_steps as f64);
    let cell_area = dx_step * dy_step;

    let lowest_perim_z = perim_samples
        .iter()
        .map(|p| p.2)
        .fold(f64::INFINITY, f64::min);
    let lowest_z = if lowest_perim_z.is_finite() {
        lowest_perim_z
    } else {
        datum_z
    };

    let (plane_a, plane_b, plane_c0, p_mean_e, p_mean_n) = plane_params;
    let mode_code: u8 = match base_mode {
        "custom_plane" => 1,
        "lowest_point" => 2,
        "best_fit_plane" => 3,
        "epoch_diff" if cmp_grid_opt.is_some() => 4,
        _ => 0,
    };

    let evals: Vec<CellEval> = py.allow_threads(|| {
        (0..nx_steps)
            .into_par_iter()
            .flat_map_iter(|ix| {
                let gx = min_e + (ix as f64 + 0.5) * dx_step;
                let grid_ref = &grid;
                let poly_ref = &poly_2d;
                let perim_ref = &perim_samples;
                let cmp_ref = &cmp_grid_opt;
                (0..ny_steps).filter_map(move |iy| {
                    let gy = min_n + (iy as f64 + 0.5) * dy_step;
                    if !point_in_poly(gx, gy, poly_ref) {
                        return None;
                    }
                    let (z_surf_raw, dz_de, dz_dn) =
                        sample_dsm_grid(grid_ref, nx, ny, e_min, n_min, res, gx, gy);
                    let z_surf = z_surf_raw + v_shift;

                    let z_base = match mode_code {
                        1 => datum_z,
                        2 => lowest_z,
                        3 => plane_a * (gx - p_mean_e) + plane_b * (gy - p_mean_n) + plane_c0,
                        4 => {
                            if let Some((cg, cnx, cny, ce_min, cn_min, cres, cshift)) = cmp_ref {
                                let (zb_raw, _, _) =
                                    sample_dsm_grid(cg, *cnx, *cny, *ce_min, *cn_min, *cres, gx, gy);
                                zb_raw + *cshift
                            } else {
                                datum_z
                            }
                        }
                        _ => {
                            let mut w_sum = 0.0f64;
                            let mut z_interp = 0.0f64;
                            for &(vx, vy, vz) in perim_ref {
                                let dx = gx - vx;
                                let dy = gy - vy;
                                let w = 1.0 / (dx * dx + dy * dy + 0.04);
                                w_sum += w;
                                z_interp += w * vz;
                            }
                            z_interp / w_sum.max(1e-9)
                        }
                    };

                    let dz = z_surf - z_base;
                    let surf_factor = (1.0 + dz_de * dz_de + dz_dn * dz_dn).sqrt();
                    Some(CellEval {
                        gx,
                        gy,
                        z_surf,
                        z_base,
                        dz,
                        surf_factor,
                    })
                })
            })
            .collect()
    });

    let inside_cells = evals.len();
    let mut fill_vol = 0.0f64;
    let mut cut_vol = 0.0f64;
    let mut surface_area = 0.0f64;
    let mut max_dz = -1e9f64;
    let mut min_dz = 1e9f64;

    let vis_stride = (inside_cells / 2000).max(1);
    let (origin_e, origin_n, origin_h) = origin_enh;

    let heatmap_list = PyList::empty_bound(py);
    let mut hm_count = 0usize;

    for (idx, ev) in evals.iter().enumerate() {
        if ev.dz > max_dz {
            max_dz = ev.dz;
        }
        if ev.dz < min_dz {
            min_dz = ev.dz;
        }
        if ev.dz >= 0.0 {
            fill_vol += ev.dz * cell_area;
        } else {
            cut_vol += ev.dz.abs() * cell_area;
        }
        surface_area += cell_area * ev.surf_factor;

        if idx % vis_stride == 0 && hm_count < 2500 {
            let cell_dict = PyDict::new_bound(py);
            cell_dict.set_item("e", round2(ev.gx))?;
            cell_dict.set_item("n", round2(ev.gy))?;
            cell_dict.set_item("z_surf", round3(ev.z_surf))?;
            cell_dict.set_item("z_base", round3(ev.z_base))?;
            cell_dict.set_item("dz", round3(ev.dz))?;
            cell_dict.set_item("lx", round3(ev.gx - origin_e))?;
            cell_dict.set_item("ly_surf", round3(ev.z_surf - origin_h))?;
            cell_dict.set_item("ly_base", round3(ev.z_base - origin_h))?;
            cell_dict.set_item("lz", round3(origin_n - ev.gy))?;
            cell_dict.set_item("step_x", round4(dx_step))?;
            cell_dict.set_item("step_z", round4(dy_step))?;
            heatmap_list.append(cell_dict)?;
            hm_count += 1;
        }
    }

    let out = PyDict::new_bound(py);
    out.set_item("fill_vol", fill_vol)?;
    out.set_item("cut_vol", cut_vol)?;
    out.set_item("surface_area", surface_area)?;
    out.set_item("max_dz", max_dz)?;
    out.set_item("min_dz", min_dz)?;
    out.set_item("inside_cells", inside_cells)?;
    out.set_item("nx_steps", nx_steps)?;
    out.set_item("ny_steps", ny_steps)?;
    out.set_item("cell_area", cell_area)?;
    out.set_item("heatmap_cells", heatmap_list)?;
    Ok(out)
}

// ============================================================================
// 3. Parallel Marching Squares, RDP Simplification & 2D Polygon Clipping
// ============================================================================

fn ms_case_edges(code: u8) -> &'static [(u8, u8)] {
    match code {
        1 => &[(3, 0)],
        2 => &[(0, 1)],
        3 => &[(3, 1)],
        4 => &[(1, 2)],
        5 => &[(3, 2), (0, 1)],
        6 => &[(0, 2)],
        7 => &[(3, 2)],
        8 => &[(2, 3)],
        9 => &[(0, 2)],
        10 => &[(0, 3), (1, 2)],
        11 => &[(1, 2)],
        12 => &[(1, 3)],
        13 => &[(0, 1)],
        14 => &[(3, 0)],
        _ => &[],
    }
}

fn rdp_simplify_2d(pts: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    let n = pts.len();
    if n <= 3 {
        return pts.to_vec();
    }
    let is_closed = (pts[0].0 - pts[n - 1].0).hypot(pts[0].1 - pts[n - 1].1) < 1e-3;
    if is_closed && n > 4 {
        let mid = n / 2;
        let mut left = rdp_simplify_2d(&pts[..=mid], tol);
        let right = rdp_simplify_2d(&pts[mid..], tol);
        left.pop();
        left.extend_from_slice(&right);
        return left;
    }

    let (x1, y1) = pts[0];
    let (x2, y2) = pts[n - 1];
    let dx = x2 - x1;
    let dy = y2 - y1;
    let seg_len = dx.hypot(dy);
    let mut max_d = -1.0f64;
    let mut max_idx = 0usize;

    for i in 1..(n - 1) {
        let (px, py) = pts[i];
        let d = if seg_len < 1e-9 {
            (px - x1).hypot(py - y1)
        } else {
            (dy * px - dx * py + x2 * y1 - y2 * x1).abs() / seg_len
        };
        if d > max_d {
            max_d = d;
            max_idx = i;
        }
    }

    if max_d > tol {
        let mut left = rdp_simplify_2d(&pts[..=max_idx], tol);
        let right = rdp_simplify_2d(&pts[max_idx..], tol);
        left.pop();
        left.extend_from_slice(&right);
        left
    } else {
        vec![pts[0], pts[n - 1]]
    }
}

#[inline]
fn segment_intersect_2d(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    cx: f64,
    cy: f64,
    dx: f64,
    dy: f64,
) -> Option<f64> {
    let rx = bx - ax;
    let ry = by - ay;
    let sx = dx - cx;
    let sy = dy - cy;
    let denom = rx * sy - ry * sx;
    if denom.abs() < 1e-12 {
        return None;
    }
    let qpx = cx - ax;
    let qpy = cy - ay;
    let t = (qpx * sy - qpy * sx) / denom;
    let u = (qpx * ry - qpy * rx) / denom;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
        Some(t)
    } else {
        None
    }
}

fn clip_polyline_to_polygon(
    pts_twd: &[[f64; 3]],
    ce: f64,
    cn: f64,
    ch: f64,
    poly_2d: &[(f64, f64)],
) -> Vec<(Vec<[f64; 3]>, Vec<[f64; 3]>)> {
    if pts_twd.len() < 2 || poly_2d.len() < 3 {
        return Vec::new();
    }
    let n_poly = poly_2d.len();
    let mut clipped_twd: Vec<Vec<[f64; 3]>> = Vec::new();
    let mut current_run: Vec<[f64; 3]> = Vec::new();

    for i in 0..(pts_twd.len() - 1) {
        let [ax, ay, az] = pts_twd[i];
        let [bx, by, bz] = pts_twd[i + 1];

        let mut t_vals = Vec::with_capacity(6);
        t_vals.push(0.0);
        t_vals.push(1.0);
        for j in 0..n_poly {
            let (cx, cy) = poly_2d[j];
            let (dx, dy) = poly_2d[(j + 1) % n_poly];
            if let Some(t_hit) = segment_intersect_2d(ax, ay, bx, by, cx, cy, dx, dy) {
                t_vals.push(t_hit);
            }
        }
        t_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut unique_t = Vec::with_capacity(t_vals.len());
        unique_t.push(t_vals[0]);
        for &tv in &t_vals[1..] {
            if tv - *unique_t.last().unwrap() > 1e-5 {
                unique_t.push(tv);
            }
        }

        for k in 0..(unique_t.len() - 1) {
            let ta = unique_t[k];
            let tb = unique_t[k + 1];
            let tm = 0.5 * (ta + tb);
            let mx = ax + tm * (bx - ax);
            let my = ay + tm * (by - ay);
            if point_in_poly(mx, my, poly_2d) {
                let pa = [
                    round3(ax + ta * (bx - ax)),
                    round3(ay + ta * (by - ay)),
                    round3(az + ta * (bz - az)),
                ];
                let pb = [
                    round3(ax + tb * (bx - ax)),
                    round3(ay + tb * (by - ay)),
                    round3(az + tb * (bz - az)),
                ];
                if current_run.is_empty() {
                    current_run.push(pa);
                    current_run.push(pb);
                } else {
                    let last_pt = *current_run.last().unwrap();
                    if (last_pt[0] - pa[0]).hypot(last_pt[1] - pa[1]) < 1e-2 {
                        current_run.push(pb);
                    } else {
                        if current_run.len() >= 2 {
                            clipped_twd.push(std::mem::take(&mut current_run));
                        } else {
                            current_run.clear();
                        }
                        current_run.push(pa);
                        current_run.push(pb);
                    }
                }
            } else {
                if current_run.len() >= 2 {
                    clipped_twd.push(std::mem::take(&mut current_run));
                } else {
                    current_run.clear();
                }
            }
        }
    }
    if current_run.len() >= 2 {
        clipped_twd.push(current_run);
    }

    let mut result = Vec::with_capacity(clipped_twd.len());
    for sub_twd in clipped_twd {
        let sub_loc: Vec<[f64; 3]> = sub_twd
            .iter()
            .map(|pt| [round3(pt[0] - ce), round3(pt[2] - ch), round3(cn - pt[1])])
            .collect();
        result.push((sub_twd, sub_loc));
    }
    result
}

fn extract_marching_squares_level(
    grid: &[f32],
    valid_mask: &[u8],
    nx: usize,
    ny: usize,
    e_min: f64,
    n_min: f64,
    res: f64,
    level: f64,
) -> Vec<Vec<[f64; 3]>> {
    if nx < 2 || ny < 2 {
        return Vec::new();
    }
    type EdgeKey = (u8, usize, usize);
    let mut edge_coords: HashMap<EdgeKey, (f64, f64)> = HashMap::new();
    let mut adj: HashMap<EdgeKey, Vec<EdgeKey>> = HashMap::new();
    let mut adj_insertion_order: Vec<EdgeKey> = Vec::new();

    for j in 0..(ny - 1) {
        for i in 0..(nx - 1) {
            let idx00 = j * nx + i;
            let idx10 = j * nx + (i + 1);
            let idx11 = (j + 1) * nx + (i + 1);
            let idx01 = (j + 1) * nx + i;

            if valid_mask[idx00] == 0
                || valid_mask[idx10] == 0
                || valid_mask[idx11] == 0
                || valid_mask[idx01] == 0
            {
                continue;
            }

            let val00 = grid[idx00] as f64;
            let val10 = grid[idx10] as f64;
            let val11 = grid[idx11] as f64;
            let val01 = grid[idx01] as f64;
            if !val00.is_finite() || !val10.is_finite() || !val11.is_finite() || !val01.is_finite() {
                continue;
            }

            let mut code = 0u8;
            if val00 >= level {
                code |= 1;
            }
            if val10 >= level {
                code |= 2;
            }
            if val11 >= level {
                code |= 4;
            }
            if val01 >= level {
                code |= 8;
            }
            if code == 0 || code == 15 {
                continue;
            }
            let pairs = ms_case_edges(code);
            if pairs.is_empty() {
                continue;
            }

            let x0 = e_min + (i as f64) * res;
            let y0 = n_min + (j as f64) * res;

            let mut get_edge_key = |e_id: u8| -> EdgeKey {
                match e_id {
                    0 => {
                        let key = (0u8, j, i);
                        edge_coords.entry(key).or_insert_with(|| {
                            let dv = val10 - val00;
                            let t = if dv.abs() > 1e-9 { (level - val00) / dv } else { 0.5 };
                            (x0 + t.clamp(0.0, 1.0) * res, y0)
                        });
                        key
                    }
                    1 => {
                        let key = (1u8, j, i + 1);
                        edge_coords.entry(key).or_insert_with(|| {
                            let dv = val11 - val10;
                            let t = if dv.abs() > 1e-9 { (level - val10) / dv } else { 0.5 };
                            (x0 + res, y0 + t.clamp(0.0, 1.0) * res)
                        });
                        key
                    }
                    2 => {
                        let key = (0u8, j + 1, i);
                        edge_coords.entry(key).or_insert_with(|| {
                            let dv = val11 - val01;
                            let t = if dv.abs() > 1e-9 { (level - val01) / dv } else { 0.5 };
                            (x0 + t.clamp(0.0, 1.0) * res, y0 + res)
                        });
                        key
                    }
                    _ => {
                        let key = (1u8, j, i);
                        edge_coords.entry(key).or_insert_with(|| {
                            let dv = val01 - val00;
                            let t = if dv.abs() > 1e-9 { (level - val00) / dv } else { 0.5 };
                            (x0, y0 + t.clamp(0.0, 1.0) * res)
                        });
                        key
                    }
                }
            };

            for &(e_a, e_b) in pairs {
                let k_a = get_edge_key(e_a);
                let k_b = get_edge_key(e_b);
                if k_a != k_b {
                    if !adj.contains_key(&k_a) {
                        adj_insertion_order.push(k_a);
                    }
                    adj.entry(k_a).or_default().push(k_b);
                    if !adj.contains_key(&k_b) {
                        adj_insertion_order.push(k_b);
                    }
                    adj.entry(k_b).or_default().push(k_a);
                }
            }
        }
    }

    if adj.is_empty() {
        return Vec::new();
    }

    let mut nodes_ordered = adj_insertion_order;
    nodes_ordered.sort_by_key(|k| adj[k].len());

    let mut visited_edges: HashSet<(EdgeKey, EdgeKey)> = HashSet::new();
    let mut polylines: Vec<Vec<[f64; 3]>> = Vec::new();
    let level_r = round3(level);

    for start_node in nodes_ordered {
        let start_neighbors = adj[&start_node].clone();
        for nxt in start_neighbors {
            let ekey = if start_node < nxt {
                (start_node, nxt)
            } else {
                (nxt, start_node)
            };
            if visited_edges.contains(&ekey) {
                continue;
            }
            let mut chain = vec![start_node, nxt];
            visited_edges.insert(ekey);
            let mut curr = nxt;
            while let Some(neighbors) = adj.get(&curr) {
                let mut found_next = None;
                for &cand in neighbors {
                    let ckey = if curr < cand {
                        (curr, cand)
                    } else {
                        (cand, curr)
                    };
                    if !visited_edges.contains(&ckey) {
                        visited_edges.insert(ckey);
                        found_next = Some(cand);
                        break;
                    }
                }
                match found_next {
                    Some(fn_node) => {
                        chain.push(fn_node);
                        curr = fn_node;
                        if curr == start_node {
                            break;
                        }
                    }
                    None => break,
                }
            }
            if chain.len() >= 4 {
                let raw_2d: Vec<(f64, f64)> = chain.iter().map(|k| edge_coords[k]).collect();
                let mut length_m = 0.0f64;
                for m in 0..(raw_2d.len() - 1) {
                    length_m += (raw_2d[m + 1].0 - raw_2d[m].0).hypot(raw_2d[m + 1].1 - raw_2d[m].1);
                }
                if length_m >= 1.5 {
                    let simp_2d = rdp_simplify_2d(&raw_2d, 0.06);
                    let poly_3d: Vec<[f64; 3]> = simp_2d
                        .into_iter()
                        .map(|(px, py)| [round3(px), round3(py), level_r])
                        .collect();
                    polylines.push(poly_3d);
                }
            }
        }
    }
    polylines
}

#[pyfunction]
fn extract_and_clip_contours_parallel<'py>(
    py: Python<'py>,
    sub_grid_bytes: &[u8],
    sub_hull_bytes: &[u8],
    nx: usize,
    ny: usize,
    sub_e_min: f64,
    sub_n_min: f64,
    res: f64,
    levels: Vec<f64>,
    major_interval: f64,
    ce: f64,
    cn: f64,
    ch: f64,
    poly_2d: Vec<(f64, f64)>,
) -> PyResult<Bound<'py, PyList>> {
    let grid = bytes_to_f32_vec(sub_grid_bytes)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(e))?;
    if grid.len() != nx * ny || sub_hull_bytes.len() != nx * ny {
        return Err(pyo3::exceptions::PyValueError::new_err(
            "Grid or hull_mask buffer size mismatch in extract_and_clip_contours_parallel",
        ));
    }

    let safe_major = if major_interval.is_finite() && major_interval > 1e-6 {
        major_interval
    } else {
        1.0
    };
    let level_results: Vec<(f64, bool, Vec<(Vec<[f64; 3]>, Vec<[f64; 3]>)>)> = py.allow_threads(|| {
        levels
            .par_iter()
            .map(|&elev| {
                let ratio = elev / safe_major;
                let is_major = (ratio - ratio.round()).abs() < 1e-3;
                let raw_polylines = extract_marching_squares_level(
                    &grid,
                    sub_hull_bytes,
                    nx,
                    ny,
                    sub_e_min,
                    sub_n_min,
                    res,
                    elev,
                );
                let mut clipped_all = Vec::new();
                for raw_twd in raw_polylines {
                    let parts = clip_polyline_to_polygon(&raw_twd, ce, cn, ch, &poly_2d);
                    clipped_all.extend(parts);
                }
                (elev, is_major, clipped_all)
            })
            .collect()
    });

    let contours_out = PyList::empty_bound(py);
    for (elev, is_major, clipped_parts) in level_results {
        let layer_name = if is_major { "C-TOPO-MAJR" } else { "C-TOPO-MINR" };
        for (sub_twd, sub_local) in clipped_parts {
            let item = PyDict::new_bound(py);
            item.set_item("elevation_m", elev)?;
            item.set_item("is_major", is_major)?;
            item.set_item("layer", layer_name)?;

            let loc_list = PyList::empty_bound(py);
            for pt in sub_local {
                loc_list.append(vec![pt[0], pt[1], pt[2]])?;
            }
            let twd_list = PyList::empty_bound(py);
            for pt in sub_twd {
                twd_list.append(vec![pt[0], pt[1], pt[2]])?;
            }
            item.set_item("points_local", loc_list)?;
            item.set_item("points_twd97", twd_list)?;
            contours_out.append(item)?;
        }
    }
    Ok(contours_out)
}

// ============================================================================
// 4. 3D Voxel Superfacet Structure Tensor & Closed-Form 3x3 Eigensolver
// ============================================================================

/// Solves a real symmetric 3x3 matrix for eigenvalues (l3 <= l2 <= l1) and the principal eigenvector e1 (for l1)
/// using cyclic Jacobi rotations (converges to machine precision in <= 12 sweeps).
fn sym3x3_eigen(
    a00: f64,
    a01: f64,
    a02: f64,
    a11: f64,
    a12: f64,
    a22: f64,
) -> ([f64; 3], [f32; 3]) {
    let mut m = [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]];
    let mut v = [[1.0f64, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

    for _sweep in 0..12 {
        let off = m[0][1].abs() + m[0][2].abs() + m[1][2].abs();
        if off < 1e-18 {
            break;
        }
        for &(p, q) in &[(0usize, 1usize), (0, 2), (1, 2)] {
            let apq = m[p][q];
            if apq.abs() < 1e-20 {
                continue;
            }
            let app = m[p][p];
            let aqq = m[q][q];
            let tau = (aqq - app) / (2.0 * apq);
            let t = if tau >= 0.0 {
                1.0 / (tau + (1.0 + tau * tau).sqrt())
            } else {
                -1.0 / (-tau + (1.0 + tau * tau).sqrt())
            };
            let c = 1.0 / (1.0 + t * t).sqrt();
            let s = t * c;

            m[p][p] = app - t * apq;
            m[q][q] = aqq + t * apq;
            m[p][q] = 0.0;
            m[q][p] = 0.0;

            let r = 3 - p - q;
            let apr = m[p][r];
            let aqr = m[q][r];
            m[p][r] = c * apr - s * aqr;
            m[r][p] = m[p][r];
            m[q][r] = s * apr + c * aqr;
            m[r][q] = m[q][r];

            for k in 0..3 {
                let vkp = v[k][p];
                let vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }

    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&i, &j| {
        m[i][i]
            .partial_cmp(&m[j][j])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let evals = [m[idx[0]][idx[0]], m[idx[1]][idx[1]], m[idx[2]][idx[2]]];
    let i_max = idx[2];
    let e1 = [
        v[0][i_max] as f32,
        v[1][i_max] as f32,
        v[2][i_max] as f32,
    ];
    (evals, e1)
}

#[pyfunction]
#[pyo3(signature = (centroids_bytes, normals_bytes, area_3d_bytes, voxel_size=0.25))]
fn compute_voxel_tensor_features<'py>(
    py: Python<'py>,
    centroids_bytes: &[u8],
    normals_bytes: &[u8],
    area_3d_bytes: &[u8],
    voxel_size: f64,
) -> PyResult<Bound<'py, PyDict>> {
    let centroids = bytes_to_f64_vec(centroids_bytes)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(e))?;
    let normals = bytes_to_f64_vec(normals_bytes)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(e))?;
    let area_3d = bytes_to_f64_vec(area_3d_bytes)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(e))?;

    let n_tris = area_3d.len();
    if centroids.len() != n_tris * 3
        || normals.len() != n_tris * 3
        || n_tris < 12
        || !voxel_size.is_finite()
        || voxel_size <= 1e-4
    {
        return Err(pyo3::exceptions::PyValueError::new_err(
            "Invalid triangle array lengths or voxel_size in compute_voxel_tensor_features",
        ));
    }
    if centroids.iter().any(|v| !v.is_finite())
        || normals.iter().any(|v| !v.is_finite())
        || area_3d.iter().any(|v| !v.is_finite())
    {
        return Err(pyo3::exceptions::PyValueError::new_err(
            "Non-finite values in compute_voxel_tensor_features inputs",
        ));
    }

    let (
        tri_r_normal,
        tri_sigma_n,
        tri_linearity,
        tri_planarity,
        tri_scattering,
        vox_centroids_flat,
        vox_normals_flat,
        vox_w,
        linearity_vox,
        e1_dirs_flat,
        inv_idx_i32,
        n_vox,
    ) = py.allow_threads(|| {
        let mut c_min = [f64::INFINITY; 3];
        for t in 0..n_tris {
            let cx = centroids[t * 3];
            let cy = centroids[t * 3 + 1];
            let cz = centroids[t * 3 + 2];
            if cx < c_min[0] {
                c_min[0] = cx;
            }
            if cy < c_min[1] {
                c_min[1] = cy;
            }
            if cz < c_min[2] {
                c_min[2] = cz;
            }
        }

        let mut ijk = Vec::with_capacity(n_tris * 3);
        let mut max_ijk = [0i64; 3];
        for t in 0..n_tris {
            let ix = ((centroids[t * 3] - c_min[0]) / voxel_size).floor().max(0.0) as i64;
            let iy = ((centroids[t * 3 + 1] - c_min[1]) / voxel_size).floor().max(0.0) as i64;
            let iz = ((centroids[t * 3 + 2] - c_min[2]) / voxel_size).floor().max(0.0) as i64;
            if ix > max_ijk[0] {
                max_ijk[0] = ix;
            }
            if iy > max_ijk[1] {
                max_ijk[1] = iy;
            }
            if iz > max_ijk[2] {
                max_ijk[2] = iz;
            }
            ijk.push(ix);
            ijk.push(iy);
            ijk.push(iz);
        }

        let span_x = max_ijk[0].saturating_add(2);
        let span_y = max_ijk[1].saturating_add(2);
        let stride_y = span_x;
        let stride_z = span_x.saturating_mul(span_y);

        let mut v_keys = Vec::with_capacity(n_tris);
        for t in 0..n_tris {
            let k = ijk[t * 3]
                .saturating_add(ijk[t * 3 + 1].saturating_mul(stride_y))
                .saturating_add(ijk[t * 3 + 2].saturating_mul(stride_z));
            v_keys.push(k);
        }

        let mut uniq_keys = v_keys.clone();
        uniq_keys.sort_unstable();
        uniq_keys.dedup();
        let n_vox = uniq_keys.len();

        let mut inv_idx = Vec::with_capacity(n_tris);
        let mut inv_idx_i32 = Vec::with_capacity(n_tris);
        for &k in &v_keys {
            let pos = uniq_keys.binary_search(&k).unwrap_or(0);
            inv_idx.push(pos);
            inv_idx_i32.push(pos as i32);
        }

        let mut vox_w = vec![0.0f64; n_vox];
        let mut vox_cx = vec![0.0f64; n_vox];
        let mut vox_cy = vec![0.0f64; n_vox];
        let mut vox_cz = vec![0.0f64; n_vox];
        let mut vox_nx = vec![0.0f64; n_vox];
        let mut vox_ny = vec![0.0f64; n_vox];
        let mut vox_nz = vec![0.0f64; n_vox];

        for t in 0..n_tris {
            let vi = inv_idx[t];
            let w = area_3d[t].max(1e-6);
            vox_w[vi] += w;
            vox_cx[vi] += centroids[t * 3] * w;
            vox_cy[vi] += centroids[t * 3 + 1] * w;
            vox_cz[vi] += centroids[t * 3 + 2] * w;

            let nx = normals[t * 3];
            let ny = normals[t * 3 + 1];
            let nz = normals[t * 3 + 2];
            let fold = if nz < -0.15 || (nz.abs() <= 0.15 && nx < 0.0) {
                -1.0
            } else {
                1.0
            };
            vox_nx[vi] += nx * fold * w;
            vox_ny[vi] += ny * fold * w;
            vox_nz[vi] += nz * fold * w;
        }

        let mut vox_centroids = Vec::with_capacity(n_vox);
        let mut vox_centroids_flat = Vec::with_capacity(n_vox * 3);
        let mut vox_normals_flat = Vec::with_capacity(n_vox * 3);

        for vi in 0..n_vox {
            let ws = vox_w[vi].max(1e-9);
            let cx = vox_cx[vi] / ws;
            let cy = vox_cy[vi] / ws;
            let cz = vox_cz[vi] / ws;
            vox_centroids.push([cx, cy, cz]);
            vox_centroids_flat.push(cx);
            vox_centroids_flat.push(cy);
            vox_centroids_flat.push(cz);

            let nn = (vox_nx[vi] * vox_nx[vi] + vox_ny[vi] * vox_ny[vi] + vox_nz[vi] * vox_nz[vi])
                .sqrt()
                .max(1e-9);
            vox_normals_flat.push(vox_nx[vi] / nn);
            vox_normals_flat.push(vox_ny[vi] / nn);
            vox_normals_flat.push(vox_nz[vi] / nn);
        }

        // Spatial hash grid at cell_r = 0.85m for O(N) neighborhood queries within r = 0.85m
        let r_search = 0.85f64;
        let r_sq = r_search * r_search;
        let mut spatial_buckets: HashMap<(i32, i32, i32), Vec<usize>> =
            HashMap::with_capacity(n_vox);
        for (vi, &[cx, cy, cz]) in vox_centroids.iter().enumerate() {
            let bx = ((cx - c_min[0]) / r_search).floor() as i32;
            let by = ((cy - c_min[1]) / r_search).floor() as i32;
            let bz = ((cz - c_min[2]) / r_search).floor() as i32;
            spatial_buckets.entry((bx, by, bz)).or_default().push(vi);
        }

        let vox_feats: Vec<(f32, f32, f32, f32, f32, [f32; 3])> = (0..n_vox)
            .into_par_iter()
            .map(|vi| {
                let [cx, cy, cz] = vox_centroids[vi];
                let bx = ((cx - c_min[0]) / r_search).floor() as i32;
                let by = ((cy - c_min[1]) / r_search).floor() as i32;
                let bz = ((cz - c_min[2]) / r_search).floor() as i32;

                let mut agg_w = 0.0f64;
                let mut agg_nx = 0.0f64;
                let mut agg_ny = 0.0f64;
                let mut agg_nz = 0.0f64;
                let mut cov_xx = 0.0f64;
                let mut cov_xy = 0.0f64;
                let mut cov_xz = 0.0f64;
                let mut cov_yy = 0.0f64;
                let mut cov_yz = 0.0f64;
                let mut cov_zz = 0.0f64;

                for dbx in -1..=1 {
                    for dby in -1..=1 {
                        for dbz in -1..=1 {
                            if let Some(bucket) =
                                spatial_buckets.get(&(bx + dbx, by + dby, bz + dbz))
                            {
                                for &vj in bucket {
                                    let [jx, jy, jz] = vox_centroids[vj];
                                    let dx = jx - cx;
                                    let dy = jy - cy;
                                    let dz = jz - cz;
                                    let d2 = dx * dx + dy * dy + dz * dz;
                                    if d2 <= r_sq {
                                        let wj = vox_w[vj];
                                        agg_w += wj;
                                        agg_nx += vox_nx[vj];
                                        agg_ny += vox_ny[vj];
                                        agg_nz += vox_nz[vj];
                                        if vj != vi {
                                            cov_xx += wj * dx * dx;
                                            cov_xy += wj * dx * dy;
                                            cov_xz += wj * dx * dz;
                                            cov_yy += wj * dy * dy;
                                            cov_yz += wj * dy * dz;
                                            cov_zz += wj * dz * dz;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                let r_norm = ((agg_nx * agg_nx + agg_ny * agg_ny + agg_nz * agg_nz).sqrt()
                    / agg_w.max(1e-9))
                .clamp(0.0, 1.0) as f32;
                let sigma_n = 1.0f32 - r_norm;

                let (evals, e1_dir) = sym3x3_eigen(
                    cov_xx + 1e-5,
                    cov_xy,
                    cov_xz,
                    cov_yy + 1e-5,
                    cov_yz,
                    cov_zz + 1e-5,
                );
                let l3 = evals[0].max(0.0);
                let l2 = evals[1].max(1e-7);
                let l1 = evals[2].max(1e-6);
                let lin = ((l1 - l2) / l1).clamp(0.0, 1.0) as f32;
                let plan = ((l2 - l3) / l1).clamp(0.0, 1.0) as f32;
                let scat = (l3 / l1).clamp(0.0, 1.0) as f32;

                (r_norm, sigma_n, lin, plan, scat, e1_dir)
            })
            .collect();

        let mut r_normal_vox = Vec::with_capacity(n_vox);
        let mut sigma_n_vox = Vec::with_capacity(n_vox);
        let mut linearity_vox = Vec::with_capacity(n_vox);
        let mut planarity_vox = Vec::with_capacity(n_vox);
        let mut scattering_vox = Vec::with_capacity(n_vox);
        let mut e1_dirs_flat = Vec::with_capacity(n_vox * 3);

        for &(rn, sn, lin, plan, scat, e1) in &vox_feats {
            r_normal_vox.push(rn);
            sigma_n_vox.push(sn);
            linearity_vox.push(lin);
            planarity_vox.push(plan);
            scattering_vox.push(scat);
            e1_dirs_flat.push(e1[0]);
            e1_dirs_flat.push(e1[1]);
            e1_dirs_flat.push(e1[2]);
        }

        let mut tri_r_normal = Vec::with_capacity(n_tris);
        let mut tri_sigma_n = Vec::with_capacity(n_tris);
        let mut tri_linearity = Vec::with_capacity(n_tris);
        let mut tri_planarity = Vec::with_capacity(n_tris);
        let mut tri_scattering = Vec::with_capacity(n_tris);

        for &vi in &inv_idx {
            tri_r_normal.push(r_normal_vox[vi]);
            tri_sigma_n.push(sigma_n_vox[vi]);
            tri_linearity.push(linearity_vox[vi]);
            tri_planarity.push(planarity_vox[vi]);
            tri_scattering.push(scattering_vox[vi]);
        }

        (
            tri_r_normal,
            tri_sigma_n,
            tri_linearity,
            tri_planarity,
            tri_scattering,
            vox_centroids_flat,
            vox_normals_flat,
            vox_w,
            linearity_vox,
            e1_dirs_flat,
            inv_idx_i32,
            n_vox,
        )
    });

    let out = PyDict::new_bound(py);
    out.set_item("n_tris", n_tris)?;
    out.set_item("n_vox", n_vox)?;
    out.set_item(
        "tri_r_normal",
        PyBytes::new_bound(py, &f32_slice_to_bytes(&tri_r_normal)),
    )?;
    out.set_item(
        "tri_sigma_n",
        PyBytes::new_bound(py, &f32_slice_to_bytes(&tri_sigma_n)),
    )?;
    out.set_item(
        "tri_linearity",
        PyBytes::new_bound(py, &f32_slice_to_bytes(&tri_linearity)),
    )?;
    out.set_item(
        "tri_planarity",
        PyBytes::new_bound(py, &f32_slice_to_bytes(&tri_planarity)),
    )?;
    out.set_item(
        "tri_scattering",
        PyBytes::new_bound(py, &f32_slice_to_bytes(&tri_scattering)),
    )?;
    out.set_item(
        "voxel_centroids",
        PyBytes::new_bound(py, &f64_slice_to_bytes(&vox_centroids_flat)),
    )?;
    out.set_item(
        "voxel_normals",
        PyBytes::new_bound(py, &f64_slice_to_bytes(&vox_normals_flat)),
    )?;
    out.set_item(
        "voxel_areas",
        PyBytes::new_bound(py, &f64_slice_to_bytes(&vox_w)),
    )?;
    out.set_item(
        "voxel_linearity",
        PyBytes::new_bound(py, &f32_slice_to_bytes(&linearity_vox)),
    )?;
    out.set_item(
        "voxel_e1_dirs",
        PyBytes::new_bound(py, &f32_slice_to_bytes(&e1_dirs_flat)),
    )?;
    out.set_item(
        "inv_voxel_idx",
        PyBytes::new_bound(py, &i32_slice_to_bytes(&inv_idx_i32)),
    )?;
    Ok(out)
}

#[pyfunction]
fn rust_core_info<'py>(py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new_bound(py);
    d.set_item("version", VERSION)?;
    d.set_item("rayon_threads", rayon::current_num_threads())?;
    d.set_item("cut_fill_max_grid_steps", 256usize)?;
    Ok(d)
}

#[pymodule]
fn gathering_scans_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", VERSION)?;
    m.add_function(wrap_pyfunction!(rust_core_info, m)?)?;
    m.add_function(wrap_pyfunction!(parse_obj_vertices_fast, m)?)?;
    m.add_function(wrap_pyfunction!(extract_glb_positions_fast, m)?)?;
    m.add_function(wrap_pyfunction!(integrate_cut_fill_grid, m)?)?;
    m.add_function(wrap_pyfunction!(extract_and_clip_contours_parallel, m)?)?;
    m.add_function(wrap_pyfunction!(compute_voxel_tensor_features, m)?)?;
    Ok(())
}
