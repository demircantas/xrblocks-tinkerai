# Compose Transform Contract

## Purpose

This document explains the current backend compose behavior precisely.

It is intended for frontend/backend alignment on:

- what the compose request contains
- how `transformMatrix` is interpreted
- how mesh selections are propagated to latent voxels
- how source latent voxels, source meshes, and newly created composed voxels are related

This document describes the current implementation, not an idealized future design.

## Current Compose Entry Points

The backend supports:

- `POST /compose`
- `POST /workspaces/{workspaceId}/compose`

The frontend-facing path is normally:

1. save a workspace snapshot
2. call `POST /workspaces/{workspaceId}/compose`
3. poll `GET /jobs/{jobId}`
4. load the returned composed asset

## Current Default Compose Mode

The backend currently defaults to:

- `composeMode: "notebook_v1"`
- `projectionMode: "nearest"`

These defaults are intentionally conservative.

They are meant to minimize backend-side pose reinterpretation and treat frontend-authored transforms as authoritative.

## Compose Request Shape

The relevant per-asset fields are:

```json
{
  "assetId": "asset-a",
  "latentHandle": "asset-a",
  "transformMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.25, 0, 0, 1],
  "selections": [
    {
      "nodePath": "/mesh0",
      "vertexIndices": [1, 2, 3],
      "proximity": 2.0
    }
  ]
}
```

Meaning:

- `assetId` identifies the source asset
- `latentHandle` identifies the backend latent file to load
- `transformMatrix` is the frontend-authored homogeneous `4x4` transform
- `selections[].vertexIndices` are the mesh vertices the user chose to keep
- `selections[].proximity` is the threshold used to propagate mesh selection to source latent voxels

## Homogeneous Transform Convention

The backend reads `transformMatrix` as a Three.js-style column-major `4x4`.

In code this means:

- the incoming flat `16` numbers are reshaped using column-major order
- points are treated as homogeneous position vectors `[x, y, z, 1]`
- the backend applies the transform as:

```text
p' = M * p
```

Operationally the code builds:

```text
[x y z 1] @ M^T
```

which is equivalent to applying the standard homogeneous transform matrix to column vectors.

The transform is applied to positions only.

There is no separate normal transform, tangent transform, or explicit quaternion path in compose.

## Source Data Loaded At Compose Time

For each source asset, the backend loads:

1. the saved latent field from:
   - `runs/<latentHandle>/handoff/sample.npz`
2. the persisted source mesh from:
   - `runs/<latentHandle>/handoff/source_mesh.npz`
   - or fallback `runs/<latentHandle>/mesh_0.glb`

The backend does not regenerate the source asset during compose.

That source mesh and source latent field are the compose inputs.

## Current Selection Semantics

The frontend sends kept mesh vertices.

The backend uses those kept mesh vertices in two related ways:

1. Mesh filtering
- keep only faces whose referenced vertices are all in the selected vertex set
- this produces the selected source mesh region

2. Latent voxel propagation
- compute nearest distance from each source latent voxel position to the selected mesh vertices
- keep source latent voxels whose nearest selected vertex is within `proximity`

This means:

- mesh selection is the canonical frontend state
- latent keep sets are derived on the backend

## Compose Spaces

There are three conceptually distinct things in compose:

1. Source mesh vertices
2. Source latent voxel positions
3. New composed voxel positions created from the stacked transformed meshes

The important requirement is:

- source mesh vertices and source latent voxel positions must be in the same working space before projection

If they are not, color/feature projection will be wrong even if geometry looks approximately correct.

## Current `notebook_v1` Path

The current default path is `composeMode: "notebook_v1"`.

For each asset, the backend currently does:

1. Load source latent coords and feats.
2. Load persisted source mesh vertices and faces.
3. Fit the source mesh into the source latent voxel space by matching centers and isotropic max-span scale.
4. Convert the frontend `transformMatrix` from source-mesh space into that fitted voxel-space frame.
5. Filter the source mesh by selected vertices.
6. Propagate selection from selected mesh vertices to source latent voxels using `proximity`.
7. Apply the same transformed-space matrix to:
   - selected source mesh vertices
   - kept source latent voxel positions
8. Stack all transformed source meshes from all assets.
9. Voxelize the stacked transformed mesh surface to create a new composed voxel set.
10. Project latent feature vectors from transformed old voxels to those new composed voxels.
11. Decode only the final combined latent field.

This is structurally similar to the compose notebook:

- transformed old voxels provide features
- transformed meshes define the new surface
- voxelization creates the new composed voxel positions
- nearest-neighbor projection assigns features to the new composed voxels

## Original Latent Voxels

For each source asset:

- the original latent coordinates come from `sample.npz`
- they are loaded as integer decoder-grid coordinates
- in `notebook_v1`, they are treated as the base voxel-space positions for compose

After selection propagation:

- only the kept subset remains
- the same per-asset transform is then applied to those kept source voxel positions

These transformed old voxels are the source of latent feature vectors during projection.

## Original Meshes With Frontend Selections

For each source asset:

- the backend loads the persisted source mesh
- the frontend selection references vertex indices on that persisted mesh topology
- the backend first filters the mesh using those selected vertex indices

That gives a selected source mesh region.

In `notebook_v1`, the backend then transforms that selected mesh region using the same transformed-space matrix used for the kept source latent voxels.

These transformed mesh pieces are then stacked across assets.

## New Voxels Created From Multiple Meshes

After all transformed selected meshes are stacked:

1. the backend computes one combined mesh bounding box
2. it computes one isotropic scale into decoder-grid dimensions
3. it maps the stacked transformed mesh into decoder-grid coordinates
4. it voxelizes the mesh surface

The result is a new voxel set:

- one set of composed surface voxels
- these voxels did not exist in any source asset directly
- they are created from the geometry of the stacked transformed meshes

These new voxels are the target positions for feature projection.

## Current Feature Projection Step

After voxelization:

1. the backend maps all transformed old source voxel positions into the same composed decoder-grid frame
2. it concatenates all transformed source latent features
3. it builds a nearest-neighbor search structure over transformed old source voxel positions
4. for each new composed voxel, it finds the nearest transformed old source voxel
5. it copies that old voxel's latent feature vector to the new composed voxel

With current defaults:

- `projectionMode: "nearest"`
- one nearest transformed old voxel wins

So the current default behavior is:

```text
new composed voxel feature = feature of nearest transformed old source voxel
```

## Transform Relationship Summary

For each source asset in the current default path:

```text
persisted source mesh
    -> fitted into source latent voxel space
    -> selected by kept mesh vertices
    -> transformed by frontend transformMatrix converted into compose working space

source latent voxels
    -> filtered by proximity to selected mesh vertices
    -> transformed by the same per-asset transform

all transformed selected meshes
    -> stacked together
    -> voxelized into a new composed surface voxel set

all transformed kept source voxels
    -> used as source positions for nearest-neighbor latent feature projection

new composed surface voxels
    -> receive latent features from nearest transformed old source voxels
    -> become the final combined latent field
    -> are decoded once at the end
```

## What The Backend Is Not Supposed To Do

The backend should not be treated as the owner of frontend presentation-frame corrections.

In particular, the current preferred path is to avoid backend-side compensation for:

- hidden frontend recentering
- hidden frontend grounding
- device-specific wrapper/content offsets
- ad hoc orientation sign flips to match presentation behavior

Those may exist as legacy comparison code paths, but they are not the desired contract.

## Current Risk Area

The most important risk is not the projection concept itself.

The risk is a frame mismatch before projection:

- selected transformed meshes might be in one orientation/frame
- transformed kept source latent voxels might be in a slightly different one

If that happens, the compose result can show:

- orientation mismatch
- color projected onto the wrong side
- color washed out in directions that do not match geometry

That is the main area that still needs careful frontend/backend alignment.

## What The Frontend Agent Should Verify

The frontend should verify all of the following:

1. `transformMatrix` is saved in a stable, explicit authored frame.
2. The same authored frame is used again when the asset is reloaded.
3. The vertex indices in `selections[].vertexIndices` refer to the same persisted mesh topology the backend loads at compose time.
4. Any wrapper-level content normalization is either:
   - removed from the saved transform contract
   - or made explicit and stable across devices

## Practical Contract Going Forward

The intended long-term contract is:

- frontend owns the stable authored asset frame
- backend applies as little extra pose logic as possible
- backend composes meshes and latent voxels in one consistent working space
- backend decodes only the final combined latent field

That is the contract the frontend agent should optimize for.

# Demircan's observations
- Is the recentering step that the modelviewer does possibly messing with the final transforms that we return to the frontend?
- The bounding box command possibly introduces variable offsets in the transforms. We should bring glbs "as is" for debug testing and to keep everything as simple as possible. Once we fix the projection errors, we can reintroduce features as necessary.
- We should change the scale values to `1.0` from `0.9`.
- `findModelPoseRoot` also seems unnecessary in our case. The generated models should not include any pose hierarchy. We should double-check this.
- We should remove all frontend recentering / grounding and normalization. It's fine if the models end up too big or small at this phase. We want to eliminate all culprits.
- The asset dependent way that ModelViewer changes GLBs makes it difficult to reverse engineer their transforms. We should ideally need no reverse-engineering whatsoever.
