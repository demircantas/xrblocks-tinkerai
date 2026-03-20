# SAM3D XR Strategy

## Purpose

This document is the current source of truth for integrating the XR Blocks frontend with the SAM3D backend.

It defines:

- the agreed end-to-end user workflow
- the canonical frontend and backend state model
- the backend contract the XR frontend should target
- the gaps between the desired workflow and the current frontend sample state

This document replaces the earlier phase-1 note that was centered on a single-asset prototype and a mock backend contract.

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

## Frontend Repo Reality

This repository already contains a useful XR sample, but it is still phase-1 and narrower than the agreed workflow.

### What already exists

- screenshot capture through `ScreenshotSynthesizer`
- speech prompt capture plus manual prompt fallback
- job-based generation polling
- loading a returned asset into `ModelViewer`
- save/load of one workspace record
- storage of a serialized object transform

Relevant files:

- [Sam3dWorkspaceScene.js](/home/farazfaruqi/xrblocks-tinkerai/samples/sam3d_workspace/Sam3dWorkspaceScene.js)
- [Sam3dApiClient.js](/home/farazfaruqi/xrblocks-tinkerai/samples/sam3d_workspace/Sam3dApiClient.js)
- [README.md](/home/farazfaruqi/xrblocks-tinkerai/samples/sam3d_workspace/README.md)

### What is incomplete

- the current sample only manages one active asset
- the current sample saves `transform`, but not the finalized `transformMatrix` field name
- the current sample saves empty `selections`
- the XR mesh selection interface is not implemented yet
- there is no multi-asset workspace UI yet
- there is no asset-listing UI yet
- there is no compose flow yet

## Core Principle

The frontend should never receive raw latent tensors. Latents remain backend-only.

All durable state and generated files should be stored on the backend, not in frontend session memory.

The frontend should store only asset references plus editing state.

## Canonical Frontend State Model

### Asset record

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

### Selection record

The frontend should store mesh-based selection state, not latent state.

For now, the canonical representation is:

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
- If an asset is a single mesh, `nodePath` can be a fixed root value.

### Workspace record

The workspace must be able to hold multiple assets and the current editing state for each asset.

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
- sending composition requests that reference existing backend latent handles

The frontend should not attempt to recompute latent-space edits locally.

## Backend Contract

### Generation routes

- `POST /generate`
- `GET /jobs/{jobId}`

### Persistence routes

- `GET /assets`
- `GET /workspaces`
- `POST /workspaces/{workspaceId}/save`
- `GET /workspaces/{workspaceId}`

### Future composition route

- `POST /compose`
- `GET /jobs/{jobId}`

Composition should be job-based in the same style as generation.

## Generation Contract

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
  "asset": {
    "assetId": "asset-001",
    "glbUrl": "https://.../model.glb",
    "thumbnailUrl": "data:image/png;base64,...",
    "latentHandle": "asset-001",
    "metadata": {
      "prompt": "Generate this coffee mug"
    }
  }
}
```

### Required backend behavior

- use the prompt and screenshot to isolate the intended object before running SAM3D generation
- save the latent field for later composition
- return a renderable `glb`

## Composition Contract

The current phase-1 frontend does not implement this yet, but this is the contract it should target.

### Compose request

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

The frontend does not need to manipulate latents directly. It only sends transforms and mesh selections.

### Compose response

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
      "sourceAssetIds": ["asset-a", "asset-b"]
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

This keeps the frontend independent from latent topology while still allowing latent-aware composition on the backend.

## Multi-Object Strategy

The frontend and backend should support composition of `N >= 2` assets with the same pipeline:

- each asset contributes a saved latent field
- each asset contributes zero or more mesh selections
- each asset contributes one transform matrix
- the backend applies selection propagation and transforms independently per asset
- the backend decodes one new composed asset

The API should not be special-cased for only two objects.

## Immediate Frontend Work

The next frontend work should be:

1. Move from one active asset to a workspace-level asset list.
2. Rename persisted `transform` state to `transformMatrix`.
3. Implement mesh selection UI and store real `selections`.
4. Add UI for listing and loading saved workspaces from the backend.
5. Add UI for listing and reloading saved assets from the backend.
6. Add a composition flow that submits multiple assets, transforms, and selections to the backend.
7. Keep all durable state backend-backed when `backendUrl` is provided.

## Summary

The agreed strategy is:

- generate one object from screenshot plus prompt
- keep latents on the backend
- let the frontend store transforms and mesh selections only
- support multiple saved assets in one workspace
- compose any number of assets by propagating mesh selection to latent voxels, applying transforms, and decoding a new asset on the backend

This is the workflow the XR Blocks frontend should implement against going forward.
