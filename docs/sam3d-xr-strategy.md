# SAM3D XR Strategy

## Goal

Build a browser-based XR workflow in which a user:

1. Captures a screenshot of the passthrough environment.
2. Provides a text prompt, ideally through speech plus a simple gesture-driven UI.
3. Sends the screenshot and prompt to a SAM3D backend.
4. Receives a generated textured `glb` mesh.
5. Places, moves, rotates, scales, and saves that mesh in the XR scene.
6. Selects regions of the mesh for later backend operations.
7. Saves and reloads meshes, transforms, and selections.
8. In a later phase, combines parts from multiple generated meshes into a new object.

This document is a planning note for implementation in this repository before we commit to code structure.

## Existing Building Blocks In This Repo

The current codebase already gives us several strong primitives:

- Screenshot capture through `ScreenshotSynthesizer`, including virtual-plus-camera capture paths.
- Speech input through `SpeechRecognizer`.
- A reusable interactive 3D object container through `ModelViewer`, which already supports move/rotate/scale style interactions.
- Depth and world interaction utilities that can help with placement and ray-based interaction.

That means the main work is not raw XR plumbing. The real work is:

- product flow,
- backend contract design,
- object/selection data model,
- persistence,
- and making the interaction model feel reliable in-headset.

## Recommended Product Shape

We should treat this as a stateful XR editor with a generation pipeline, not as a one-shot demo.

Recommended user flow:

1. User enters XR and sees a lightweight floating tool panel.
2. User points at a real-world object or scene region.
3. User taps `Capture`.
4. The app captures a screenshot and stores it as the current generation input.
5. User speaks or types a prompt such as `"Generate this coffee mug"`.
6. The app sends the screenshot, prompt, and optional context metadata to the backend.
7. While waiting, the app shows a progress state in-world.
8. When the backend returns a `glb`, the app creates a new editable asset in the scene.
9. The asset can be translated, rotated, and scaled using the same interaction pattern as the existing model viewer.
10. The user can switch into `Select Parts` mode and paint or volume-select mesh regions.
11. The selection is converted into vertex indices plus the asset world transform.
12. The user can save the current workspace, reload previous results, or send selected parts to the backend for recomposition.

## Recommended Frontend Architecture

We should implement this as a focused sample or demo first, not directly as broad SDK changes.

Suggested top-level modules:

- `Sam3dApp`
  Owns scene-level state and mode transitions.
- `GenerationController`
  Handles screenshot capture, prompt capture, and backend requests.
- `AssetWorkspace`
  Owns the set of loaded/generated assets in the XR session.
- `EditableAsset`
  Wraps a `glb` scene, selection data, and current transform.
- `SelectionController`
  Owns selection mesh creation, mesh hit tests, and vertex index extraction.
- `PersistenceController`
  Saves and reloads workspace state, likely through the backend.
- `Sam3dApiClient`
  Encapsulates HTTP/WebSocket communication with the backend.
- `XRToolbar`
  Floating UI for capture, record prompt, generate, transform mode, selection mode, save, load, and combine.

This gives us a clear boundary between XR interaction logic and server communication logic.

## Recommended Backend Contract

The browser should stay thin. The backend should own generation state and latent memory.

### Generate Request

Suggested request payload:

```json
{
  "sessionId": "xr-session-123",
  "requestId": "generate-001",
  "prompt": "Generate this coffee mug",
  "image": {
    "mimeType": "image/jpeg",
    "base64": "..."
  },
  "cameraContext": {
    "width": 640,
    "height": 480
  }
}
```

Suggested response payload:

```json
{
  "assetId": "asset-001",
  "glbUrl": "/artifacts/asset-001.glb",
  "thumbnailUrl": "/artifacts/asset-001.jpg",
  "metadata": {
    "prompt": "Generate this coffee mug"
  }
}
```

If the backend needs time to generate, we should prefer:

- `POST /generate`
- `GET /jobs/:id`
- or a WebSocket progress stream

instead of a single long blocking request.

### Save Workspace Request

```json
{
  "sessionId": "xr-session-123",
  "workspace": {
    "assets": [
      {
        "assetId": "asset-001",
        "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 1.2, -0.8, 1],
        "selections": [
          {
            "selectionId": "sel-001",
            "vertexIndices": [1, 2, 3, 10, 11]
          }
        ]
      }
    ]
  }
}
```

### Combine / Decode Request

```json
{
  "sessionId": "xr-session-123",
  "sourceAssets": [
    {
      "assetId": "asset-001",
      "transform": [ ... ],
      "selectedVertexIndices": [ ... ]
    },
    {
      "assetId": "asset-002",
      "transform": [ ... ],
      "selectedVertexIndices": [ ... ]
    }
  ]
}
```

Response:

- new `assetId`
- new generated `glb`
- optional updated workspace snapshot

## Scene Data Model

The frontend should treat every generated mesh as an asset record with stable IDs.

Suggested asset shape:

```ts
type AssetRecord = {
  assetId: string;
  object3D: THREE.Object3D;
  sourcePrompt?: string;
  glbUrl?: string;
  transformMatrixWorld: number[]; // 16 numbers
  selections: SelectionRecord[];
};

type SelectionRecord = {
  selectionId: string;
  label?: string;
  vertexIndices: number[];
  createdAt: number;
};
```

Important recommendation:

- keep vertex selections in the asset's local mesh indexing space,
- send transforms separately,
- and avoid baking transforms into vertex coordinates on the frontend.

That keeps the backend contract much cleaner.

## Screenshot Strategy

We should start simple and reliable.

Phase 1 screenshot behavior:

- Use the repo's screenshot synthesizer.
- Capture a single still image on explicit user action.
- Keep the capture resolution modest at first.
- Store the last captured image locally in memory so the user can confirm before sending.

Important open point:

- We need to verify whether the exact passthrough-inclusive capture path on Quest gives the backend the image semantics we expect.

Even if screenshot capture works technically, we should test:

- whether the real-world object is visible in the capture,
- whether image orientation is correct,
- whether the captured framing matches what the user thought they selected.

We should add a pre-send preview panel in XR early. That will save a lot of debugging time.

## Prompt Input Strategy

We should separate prompt capture from gesture input.

Recommended approach:

- Speech for prompt text.
- XR UI buttons for command mode and confirmation.
- Gestures/controllers for placement and selection.

Example interaction:

1. User taps `Record Prompt`.
2. Speech recognizer starts.
3. Transcript appears live in a floating panel.
4. User taps `Use Prompt`.
5. User taps `Generate`.

Important risk:

- browser speech recognition support may vary across headset browsers.

Because of that, we should build prompt entry with a fallback:

- speech first,
- manual text input second,
- optional predefined prompt shortcuts third.

## Mesh Placement and Manipulation

For generated `glb` objects, we should reuse the interaction ideas from `ModelViewer` rather than inventing a new manipulator system immediately.

Recommendation:

- wrap each generated asset in an `EditableAsset` container,
- use a `ModelViewer`-like interaction pattern for move/rotate/scale,
- store the transform as a `THREE.Matrix4` and serialize it to a flat 16-number array when talking to the backend.

We should standardize on:

- local asset coordinates for geometry,
- world transform matrix for placement,
- and one authoritative transform per asset.

## Selection Strategy

This is the area that needs the most design discipline.

The requirement is not just visual highlighting. We also need a stable mapping back to mesh vertices for backend processing.

### Recommended Selection Model

We should represent selection in two layers:

1. `SelectionVolume`
   A visible user-controlled mesh or brush volume used for interaction.
2. `SelectionResult`
   The computed set of selected vertex indices for a specific asset.

This is better than storing only the visible selection mesh, because backend operations ultimately need vertex IDs, not just a sculpting overlay.

### Initial Selection Implementation

For phase 1, we should avoid true continuous sculpting and start with a simpler volume-based selector:

- sphere selector,
- capsule selector,
- or oriented box selector.

Why:

- it is easier to debug,
- easier to serialize,
- and sufficient for validating the backend loop.

The user can move/scale the selection volume over the model and press `Apply Selection`. We then compute selected vertices by testing whether each vertex in asset-local coordinates falls inside the selection volume after accounting for transforms.

### Highlight Rendering

We should visualize selection in two ways:

- the selection volume itself,
- and a highlight overlay on selected triangles or vertices.

For the first implementation, the easiest robust path is likely:

- clone the selected triangles into a secondary highlight mesh,
- render it slightly inflated or with additive/emissive material,
- regenerate it whenever selection changes.

This is more stable than trying to mutate the original material pipeline too early.

### Vertex Index Extraction

For each selectable mesh:

1. Read position and index buffers.
2. Convert candidate vertices into a consistent coordinate space.
3. Test membership against the current selection volume.
4. Store the matching vertex indices.

Important decision:

- if a `glb` contains multiple submeshes, we should store selection by submesh, not as one global index list.

Suggested shape:

```ts
type MeshSelection = {
  nodePath: string;
  vertexIndices: number[];
};
```

That will make backend mapping more reliable.

## Save / Load Strategy

For this project, server-backed persistence is the right default.

Reasons:

- the app is browser-based,
- the backend already owns latent state,
- later recomposition depends on server memory anyway,
- and `localStorage` or IndexedDB alone would not capture the full backend-side generation state.

Recommended persistence model:

- frontend saves lightweight workspace metadata,
- backend stores both workspace metadata and latent references,
- frontend reloads by requesting a workspace snapshot from the backend.

Workspace snapshot should include:

- asset IDs,
- artifact URLs or handles,
- transforms,
- selections,
- parent/child composition metadata later on.

## Phase Plan

### Phase 1: Vertical Slice

Goal:

- prove the core loop from capture to generated asset placement.

Scope:

- screenshot capture,
- prompt input,
- backend generate call,
- `glb` return,
- place generated mesh in XR,
- move/rotate/scale mesh,
- save/load one asset record.

Do not include advanced mesh-part composition yet.

### Phase 2: Selection Pipeline

Goal:

- prove frontend-to-backend mesh part selection.

Scope:

- selection volume,
- selected vertex extraction,
- visible selection highlight,
- serialization of selections and world transform,
- backend round-trip for one selected region.

### Phase 3: Multi-Asset Workspace

Goal:

- support several generated assets in one scene and persist them cleanly.

Scope:

- asset list panel,
- select active asset,
- save/load workspace snapshots,
- multiple independent selections,
- better transform editing UX.

### Phase 4: Part Combination

Goal:

- create a new object from selected regions across multiple assets.

Scope:

- select parts from several assets,
- send all transforms plus per-asset selected indices,
- receive a decoded combined `glb`,
- place result as a new asset,
- preserve lineage metadata.

## Recommended First Deliverable

Before any selection work, we should build a narrow but complete end-to-end demo:

1. Capture screenshot from XR.
2. Enter prompt.
3. Send both to a stub or real SAM3D endpoint.
4. Receive a test `glb`.
5. Load it into an editable asset wrapper.
6. Move/rotate/scale it in the scene.
7. Save and reload that one asset via backend persistence.

This will validate:

- networking,
- asset loading,
- interaction model,
- backend session handling,
- and the basic UX loop.

If we skip this and jump straight to selections, we risk building selection logic before the asset lifecycle is stable.

## Open Questions

These are the main questions we should answer before implementation:

1. Does the SAM3D backend want raw image pixels, JPEG/PNG, or a URL upload flow?
2. Will generation be synchronous, queued, or streamed with progress?
3. Can one generated asset contain multiple named submeshes that we can address stably?
4. Does the backend expect vertex indices against the decoded mesh, latent structure, or both?
5. Do we need triangle-face selection instead of only vertex selection?
6. Should selection be additive/subtractive across multiple passes?
7. Do we need exact hand-gesture input, or are controller/reticle interactions acceptable for phase 1?
8. Does Quest browser speech recognition support meet the product requirement, or do we need a backend speech path?
9. Does the backend need camera intrinsics/extrinsics in addition to the image and prompt?

## Recommended Next Step

Implement a new sample focused on the phase-1 vertical slice and keep it intentionally narrow:

- toolbar,
- screenshot preview,
- prompt entry,
- backend generate call,
- returned `glb`,
- editable asset wrapper,
- save/load.

Once that loop feels stable in-headset, we add selection as a second milestone instead of mixing both concerns immediately.
