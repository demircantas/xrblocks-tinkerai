# SAM3D XR Strategy

## Purpose

This document is the current source of truth for integrating the XR Blocks frontend with the SAM3D backend in this repository.

It defines:

- the agreed end-to-end user workflow
- the canonical frontend and backend state model
- the backend contract the XR frontend should target
- the gaps between the desired workflow and the current repository state

This document replaces older prototype notes that were centered on a mock backend and a narrower single-asset flow.

## Agreed Product Workflow

The target workflow is:

1. The user captures a screenshot in XR.
2. The user provides a text prompt, usually via speech recognition.
3. The frontend sends the screenshot and prompt to the backend.
4. The backend isolates the object referred to by the prompt, runs SAM3D generation for that object, stores the resulting latent representation and mesh server-side, and returns a renderable `glb` plus backend handles.
5. The user places, moves, rotates, and scales the generated object in XR.
6. The user filters the mesh by selecting which mesh regions to keep. The frontend stores this selection state, but the latents remain on the backend.
7. The user can save and later reload the workspace, including all object transforms and selection state.
8. The user can repeat this for multiple generated objects.
9. The user can request composition of two or more saved objects.
10. The backend applies each object's saved transform and mesh selection to its latent field, composes the transformed latent fields into a new voxel space, decodes a new mesh, stores the new latents and mesh, and returns the composed `glb`.

## Current Repo Reality

The repository already contains useful pieces of this workflow, but it does not yet implement the full target behavior.

### What already exists

- Backend generation already saves stage-2 latent data server-side in `handoff/sample.npz` and mesh metadata in `handoff/meta.json`.
- Backend generation already exports a `mesh_0.glb` for each generated asset.
- The desktop experiment frontend can already request generated meshes and render them.
- The desktop experiment backend can already expose voxel positions derived from saved latents for selection work.
- The desktop experiment backend can already combine two assets using either a plane split or explicit voxel-index selections.
- The latent-composition notebook in [compose_latents.ipynb](/home/farazfaruqi/sam-3d-objects/get_latents/coco_sample/compose_latents.ipynb) already demonstrates the richer workflow we ultimately want on the backend: filter, transform, compose, reproject, decode, and export.

### What is broken or incomplete

- The generation path now uses prompt-driven object isolation before SAM3D, but the quality of the isolated mask is still model- and scene-dependent.
- The current desktop selection prototype is voxel-index based. It does not yet store mesh vertex selections as the canonical XR state.
- The current desktop combine path supports exactly two objects.
- The current desktop combine path does not yet implement the full `compose_latents.ipynb` workflow.
- The XR Blocks sample now supports mesh selection with keep/discard painting, saves canonical kept vertex indices, and persists selection state to the backend-backed workspace payload.
- The XR Blocks sample now includes backend-backed asset and workspace catalogs in the debug UI.
- The XR Blocks sample now includes a non-destructive per-asset kept-only visualization mode.
- The XR Blocks sample now supports workspace snapshots instead of overwriting a single default workspace id on every save.
- The XR Blocks sample now supports deleting workspaces and deleting assets from the backend catalog, with a backend-side safeguard that rejects asset deletion while the asset is still referenced by any saved workspace.
- The frontend still lacks a compose action wired to the backend contract and still uses a debug-panel-heavy workflow rather than a study-facing user UI.

## Agreed State Model

The frontend should never receive raw latent tensors. Latents remain backend-only.

The frontend should store only asset references plus editing state.

All durable state and generated files should be stored on the backend, not in frontend session memory.

### Canonical asset record

Each generated or composed object should be represented by an asset record with at least:

- `assetId`
- `latentHandle`
- `glbUrl`
- `prompt`
- `thumbnailUrl`
- `transformMatrix`
- `selections`

`transformMatrix` is a homogeneous `4x4` matrix serialized as `16` numbers.

`latentHandle` is the backend key used to retrieve the latent field for later composition. Initially, `assetId` and `latentHandle` may be the same underlying identifier.

### Canonical selection record

The frontend should store mesh-based selection state, not latent state.

For now, the agreed canonical representation is:

```ts
type MeshSelection = {
  nodePath: string;
  vertexIndices: number[];
  proximity: number;
};
```

Notes:

- `vertexIndices` means the mesh vertices the user chose to keep.
- `proximity` is the distance threshold used by the backend to propagate mesh selection to structured latent voxels.
- `nodePath` future-proofs the format for multi-node or multi-submesh assets.
- If the asset is a single mesh, `nodePath` can be a fixed root value.

### Canonical workspace record

The workspace should be able to hold multiple assets and the current editing state for each asset.

Suggested shape:

```json
{
  "workspaceId": "workspace-local",
  "workspace": {
    "sessionId": "session-...",
    "prompt": "Generate this coffee mug",
    "lastScreenshotDataUrl": "data:image/png;base64,...",
    "assets": [
      {
        "assetId": "asset-001",
        "latentHandle": "asset-001",
        "glbUrl": "https://.../model.glb",
        "prompt": "Generate this coffee mug",
        "thumbnailUrl": "data:image/png;base64,...",
        "transformMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "selections": [
          {
            "nodePath": "/mesh0",
            "vertexIndices": [1, 2, 3],
            "proximity": 2.0
          }
        ]
      }
    ]
  }
}
```

## Backend Responsibilities

The backend is responsible for:

- receiving screenshot and prompt for generation
- isolating the target object described by the prompt
- running SAM3D generation
- storing generated latents and decoded meshes server-side
- returning only renderable asset data to the frontend
- preserving latent handles so later edits refer back to the correct source asset
- saving and loading workspace state
- persisting workspaces and assets independently of the current frontend session
- exposing saved workspaces and assets for later retrieval
- applying transforms and selection propagation during composition
- decoding and storing newly composed assets

The backend is not required to send latents to the frontend.

## Persistence Requirements

Backend persistence is the source of truth for both files and state.

The backend should persist:

- generated `glb` files
- composed `glb` files
- latent files and latent handles
- workspace state
- asset metadata
- saved transform matrices
- saved mesh selection state

This persistence must be independent of the current browser or XR session.

The frontend should be able to:

- save a workspace
- list available workspaces
- list available assets
- load a previously saved workspace in a later session
- load previously generated or composed assets from backend metadata
- restore assets and editing state from the backend without relying on in-memory frontend state

## Frontend Responsibilities

The XR frontend is responsible for:

- screenshot capture
- prompt capture, including speech-input fallback behavior
- displaying generated or composed assets
- allowing object placement, rotation, and scale
- capturing mesh selections
- storing transform matrices and selection records in workspace state
- browsing previously saved assets and workspaces from backend catalog routes
- loading multiple assets into one live workspace
- providing a non-destructive visualization mode that shows only the kept mesh region for any asset
- snapshotting workspaces under new backend workspace ids instead of overwriting one default workspace id
- deleting workspaces and assets through backend catalog actions when supported by the backend routes
- sending composition requests that reference existing backend latent handles

The frontend should not attempt to recompute latent-space edits locally.

## Generation Contract

Generation is implemented today and remains job-based.

Routes:

- `GET /healthz`
- `POST /generate`
- `GET /jobs/{jobId}`

### Generate request

```json
{
  "sessionId": "session-...",
  "workspaceId": "workspace-local",
  "prompt": "Generate this coffee mug",
  "image": {
    "mimeType": "image/png",
    "dataUrl": "data:image/png;base64,..."
  }
}
```

### Generate initial response

```json
{
  "jobId": "job-001",
  "status": "queued",
  "sessionId": "session-...",
  "workspaceId": "workspace-local"
}
```

### Generate completion response

```json
{
  "jobId": "job-001",
  "status": "completed",
  "sessionId": "session-...",
  "workspaceId": "workspace-local",
  "progress": 1.0,
  "message": "Completed",
  "createdAt": 1774033750000,
  "completedAt": 1774033762000,
  "asset": {
    "assetId": "asset-001",
    "glbUrl": "https://.../model.glb",
    "thumbnailUrl": "data:image/png;base64,...",
    "latentHandle": "asset-001",
    "savedAt": 1774033762000,
    "sourceType": "generated",
    "hasLatents": true,
    "metadata": {
      "prompt": "Generate this coffee mug",
      "sessionId": "session-...",
      "workspaceId": "workspace-local",
      "jobId": "job-001"
    }
  }
}
```

### Generate failed response

```json
{
  "jobId": "job-001",
  "status": "failed",
  "progress": 1.0,
  "message": "error text",
  "error": "error text",
  "completedAt": 1774033762000
}
```

### Required behavior

- The backend must use the prompt and screenshot to isolate the intended object before running SAM3D generation.
- The backend must save the latent field for later composition.
- The backend must return a renderable `glb`.

## Save And Load Contract

Workspace save and load remain backend-backed persistence.

Routes:

- `GET /assets`
- `GET /workspaces`
- `POST /workspaces/{workspaceId}/save`
- `GET /workspaces/{workspaceId}`
- `DELETE /workspaces/{workspaceId}`
- `DELETE /assets/{assetId}`

### Current implemented listing responses

`GET /workspaces` returns lightweight summaries:

```json
{
  "items": [
    {
      "workspaceId": "workspace-local",
      "savedAt": 1774033754093,
      "assetCount": 1,
      "prompt": "Generate this coffee mug",
      "sessionId": "session-..."
    }
  ],
  "count": 1
}
```

`GET /assets` returns persisted or discovered asset summaries:

```json
{
  "items": [
    {
      "assetId": "asset-001",
      "latentHandle": "asset-001",
      "glbUrl": "https://.../api/models/asset-001/mesh_0.glb",
      "thumbnailUrl": null,
      "savedAt": 1774033704725,
      "sourceType": "generated",
      "hasLatents": true,
      "metadata": {
        "prompt": "Generate this coffee mug",
        "workspaceId": null,
        "jobId": null
      }
    }
  ],
  "count": 26
}
```

### Workspace save request

The frontend should write `transformMatrix` going forward.

```json
{
  "workspaceId": "workspace-local",
  "workspace": {
    "sessionId": "session-...",
    "prompt": "Generate this coffee mug",
    "assets": [
      {
        "assetId": "asset-001",
        "latentHandle": "asset-001",
        "glbUrl": "https://.../api/models/asset-001/mesh_0.glb",
        "transformMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "selections": [
          {
            "nodePath": "/mesh0",
            "vertexIndices": [1, 2, 3],
            "proximity": 0.03
          }
        ]
      }
    ]
  }
}
```

### Workspace save/load response

```json
{
  "workspaceId": "workspace-local",
  "savedAt": 1774033754093,
  "workspace": {
    "sessionId": "session-...",
    "prompt": "Generate this coffee mug",
    "assets": [
      {
        "assetId": "asset-001",
        "latentHandle": "asset-001",
        "glbUrl": "https://.../api/models/asset-001/mesh_0.glb",
        "transformMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "selections": [
          {
            "nodePath": "/mesh0",
            "vertexIndices": [1, 2, 3],
            "proximity": 0.03
          }
        ]
      }
    ]
  }
}
```

The backend should treat the workspace payload as the source of truth for frontend editing state:

- transform matrices
- current selections
- current asset list
- current prompt and last screenshot
- per-asset kept-only/full visualization mode when the frontend chooses to persist it

The backend should not require the frontend to upload latents as part of save/load.

`workspaceId` must be stable across sessions so a saved workspace can be reopened later by any frontend session with access to the backend.

Current frontend behavior note:

- the debug UI now treats save as a workspace snapshot action
- each snapshot generates a fresh `workspaceId` before calling `POST /workspaces/{workspaceId}/save`
- loading a workspace from the workspace catalog switches the active frontend `workspaceId` first, then calls `GET /workspaces/{workspaceId}`

The backend should also expose a stable asset-listing route so the frontend can discover previously generated and composed assets without relying on only the currently loaded workspace.

Compatibility note:

- older saved workspaces in this repo may still use `transform` instead of `transformMatrix`
- new frontend work should write `transformMatrix`
- frontend loaders should read `transformMatrix ?? transform` until old saved state is migrated

## Composition Contract

Composition should also be job-based.

The current combine route in the desktop experiment is a useful prototype, but it is too limited for the XR workflow because it only supports two objects and works directly with voxel indices.

The XR-facing contract should support an arbitrary number of source assets.

### Compose request

Suggested shape:

```json
{
  "sessionId": "session-...",
  "workspaceId": "workspace-local",
  "assets": [
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
    },
    {
      "assetId": "asset-b",
      "latentHandle": "asset-b",
      "transformMatrix": [1, 0, 0, 0, 0, 0.7, -0.7, 0, 0, 0.7, 0.7, 0, 0, 0, 0, 1],
      "selections": [
        {
          "nodePath": "/mesh0",
          "vertexIndices": [10, 11, 12],
          "proximity": 2.0
        }
      ]
    },
    {
      "assetId": "asset-c",
      "latentHandle": "asset-c",
      "transformMatrix": [0.8, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0.8, 0, -0.2, 0, 0, 1],
      "selections": []
    }
  ],
  "compose": {
    "normalizeToDecoderGrid": false
  }
}
```

### Compose behavior

For each source asset, the backend should:

1. load the saved latent field referenced by `latentHandle`
2. load the corresponding mesh representation
3. convert kept mesh vertices into a latent keep set using the selection `proximity` threshold
4. apply the submitted homogeneous transform matrix to the selected latent voxels
5. aggregate all transformed latent fields into a composed voxel space
6. project or remap the combined latents as needed for decoding
7. decode the composed latent field into a new mesh
8. save the new mesh and latent field as a new derived asset

This is the backend workflow already explored in [compose_latents.ipynb](/home/farazfaruqi/sam-3d-objects/get_latents/coco_sample/compose_latents.ipynb), but the XR API must generalize it from two notebook-loaded assets to an arbitrary-length asset list.

### Compose response

Composition should return a job first, then a completed asset in the same style as generation:

```json
{
  "jobId": "job-002",
  "status": "completed",
  "sessionId": "session-...",
  "workspaceId": "workspace-local",
  "asset": {
    "assetId": "asset-composed-001",
    "glbUrl": "https://.../asset-composed-001.glb",
    "latentHandle": "asset-composed-001",
    "metadata": {
      "sourceAssetIds": ["asset-a", "asset-b", "asset-c"]
    }
  }
}
```

## Selection Semantics

To avoid ambiguity:

- frontend selections are defined as mesh vertices to keep
- backend propagation converts those mesh selections into latent keep sets
- proximity is part of the selection contract
- if an asset has no selections, the whole asset is considered selected
- keep/discard painting in the XR UI is only an editing affordance; the saved canonical state remains kept vertex indices

This keeps the frontend independent from latent topology while still allowing latent-aware composition on the backend.

### Current frontend selection implementation note

The current XR Blocks sample computes selection from recorded brush stroke points on release. The live brush visualization is currently sphere-based because it is stable and performant enough for headset testing. A marching-cubes or metaball brush may still be revisited later as a polish task, but it is not required for the saved contract.

## Current Frontend Debug UI

The current XR Blocks frontend uses a debug-oriented multi-pane UI rather than a study-facing embodied UI.

The current panes are:

- a main panel for prompt, capture, generate, preview, reset, and diagnostics
- a selection panel for mesh filtering tools
- a library panel for asset and workspace catalogs

The current debug UI supports:

- asset catalog browsing via `GET /assets`
- workspace catalog browsing via `GET /workspaces`
- loading selected assets into the current live workspace
- snapshotting workspaces under new ids
- loading selected workspaces
- deleting selected workspaces
- deleting selected assets

Delete behavior currently expected by the frontend:

- `DELETE /workspaces/{workspaceId}` deletes one saved workspace
- `DELETE /assets/{assetId}` deletes one saved asset
- `DELETE /assets/{assetId}` returns `409` if that asset is still referenced by any saved workspace, and the frontend surfaces that safeguard message to the user

This debug UI is intentional for backend and systems testing. It is not the intended final user-study interface.

## Multi-Object Strategy

The backend should support composition of `N >= 2` assets with the same pipeline:

- each asset contributes a saved latent field
- each asset contributes zero or more mesh selections
- each asset contributes one transform matrix
- the backend applies selection propagation and transforms independently per asset
- the backend decodes one new composed asset

The API should not be special-cased for only two objects.

## Immediate Implementation Priorities

The next backend and frontend work should be:

1. Keep the current asset and workspace catalog routes stable while the frontend/backend integration is still moving quickly.
2. Keep workspace snapshots centered on frontend editing state, not latent upload.
3. Keep the non-destructive kept-only visualization mode aligned with saved mesh selections.
4. Promote the `compose_latents.ipynb` workflow into a backend composition service.
5. Replace the current two-object combine limitation with an `N`-object composition endpoint.
6. Add `GET /assets/{assetId}` for full asset metadata if the frontend needs detail beyond the list view.
7. Begin separating the debug UI from the eventual user-study UI so embodied interaction and speech-first flows can evolve without destabilizing backend testing tools.

## Summary

The agreed strategy is:

- generate one object from screenshot plus prompt
- keep latents on the backend
- let the frontend store transforms and mesh selections only
- support multiple saved assets in one workspace
- let the user browse backend asset and workspace catalogs instead of only restoring the most recent saved object implicitly
- treat workspace save as snapshot creation in the current debug UI
- support deleting saved workspaces and deleting saved assets, with backend safeguards preventing deletion of assets still referenced by saved workspaces
- provide a non-destructive kept-only visualization mode for loaded assets
- compose any number of assets by propagating mesh selection to latent voxels, applying transforms, and decoding a new asset on the backend

This is the workflow both the backend and the XR Blocks frontend should implement against going forward.

