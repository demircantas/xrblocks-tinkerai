# SAM3D XR Strategy

## Purpose

This document is the current handoff note for the SAM3D XR prototype in this repository.

It serves two roles:

1. capture the product and architecture strategy,
2. record what has already been implemented and validated on device.

The immediate next step after this note is to modify the real Google VM backend so it can receive requests from the frontend sample already built in this repo.

## Current Prototype Status

The phase-1 vertical slice is implemented and working.

Implemented frontend sample:

- [`samples/sam3d_workspace/`](../samples/sam3d_workspace)

Implemented mock backend:

- [`samples/sam3d_workspace/server/main.py`](../samples/sam3d_workspace/server/main.py)

Validated behaviors:

- the sample runs on desktop browser and Quest browser,
- Quest access over USB plus `adb reverse` works,
- XR session startup is stable on Quest after removing heavy startup dependencies,
- screenshot capture works,
- prompt capture works through manual fallback UI,
- browser speech recognition support is unreliable on Quest,
- job-based generation flow works end to end,
- the backend returns a model URL and the frontend loads it successfully,
- generated models can be moved, rotated, and scaled using `ModelViewer`,
- save/load/reset work,
- backend-backed save/load works through the Python mock backend,
- the mock backend stores request JSON, request images, and workspace JSON on disk for debugging,
- the mock backend can return different test assets based on prompt keywords or an explicit hint.

This means the basic frontend/backend XR loop is already proven.

## Product Goal

Build a browser-based XR workflow in which a user:

1. captures a screenshot of the real scene,
2. provides a text prompt, ideally by speech or lightweight manual XR input,
3. sends screenshot plus prompt to a SAM3D backend,
4. receives a generated textured `glb` mesh,
5. places, moves, rotates, scales, saves, and reloads that mesh in XR,
6. later selects regions of the mesh for backend operations,
7. later combines parts from multiple generated meshes into a new object.

## What Exists In This Repo

The current codebase already provides the main primitives needed for the prototype:

- screenshot capture through `ScreenshotSynthesizer`,
- speech input through `SpeechRecognizer`,
- XR UI panels and buttons,
- an XR virtual keyboard addon,
- interactive object manipulation through `ModelViewer`,
- placement and world interaction helpers,
- a working sample scaffold that ties these together.

Important sample files:

- [`samples/sam3d_workspace/Sam3dWorkspaceScene.js`](../samples/sam3d_workspace/Sam3dWorkspaceScene.js)
- [`samples/sam3d_workspace/Sam3dApiClient.js`](../samples/sam3d_workspace/Sam3dApiClient.js)
- [`samples/sam3d_workspace/main.js`](../samples/sam3d_workspace/main.js)
- [`samples/sam3d_workspace/README.md`](../samples/sam3d_workspace/README.md)
- [`samples/sam3d_workspace/server/main.py`](../samples/sam3d_workspace/server/main.py)
- [`samples/sam3d_workspace/server/README.md`](../samples/sam3d_workspace/server/README.md)

## Current User Flow

The currently implemented flow is:

1. User opens the `sam3d_workspace` sample.
2. User enters XR.
3. User captures a screenshot.
4. User either:
   - records a prompt through speech, or
   - edits a prompt manually through the XR keyboard fallback.
5. User presses `Generate`.
6. Frontend sends screenshot and prompt to the backend with a job-based request.
7. Frontend polls job status once per second.
8. Backend returns a completed asset payload with a renderable model URL.
9. Frontend loads the asset into a `ModelViewer`.
10. User can move, rotate, and scale the asset in XR.
11. User can save the current workspace.
12. User can reset and reload the workspace.

## Tested Device Findings

These observations are important and should be treated as current product constraints.

### Quest Browser / XR Entry

Originally, XR entry failed in the sample when camera, microphone, and related setup were exercised too early.

Current working approach:

- keep XR session startup lightweight,
- do not require microphone or camera setup before entering XR,
- only request these capabilities on explicit user action.

This change made XR session start behave reliably like the simpler `modelviewer` sample.

### Screenshot Capture

Current state:

- screenshot capture works,
- preview UI works,
- screenshot can be sent to the backend and stored.

Important limitation:

- on Quest 2 and Quest 3, screenshots did not include passthrough imagery even when `?overlayOnCamera=true` was used.

Practical conclusion:

- browser-based Quest XR currently gives us a usable screenshot mechanism for the sample,
- but it should not be assumed to provide true passthrough pixel capture,
- if real passthrough pixels are mandatory, a native Quest app path may eventually be required.

For now, the frontend should keep treating the captured image as the input image it has available, without assuming it is a full passthrough capture.

### Speech Recognition

Current state:

- microphone permissions can be requested and tested,
- mic capability diagnostics were added to the sample,
- Quest browser speech recognition did not reliably produce transcripts,
- browser speech support should be treated as optional convenience, not core infrastructure.

Practical conclusion:

- speech input should remain a best-effort feature,
- manual prompt entry must remain available,
- backend-side speech or audio upload may be a later option if needed.

### Prompt Entry Fallback

A manual fallback now exists in the sample:

- `Edit Prompt` opens the XR keyboard,
- `Use Default` restores a baseline prompt,
- an additional `Backspace` panel button was added because the keyboard addon's built-in backspace key did not work reliably in this flow.

This fallback should be treated as required, not optional.

## Current Frontend Architecture

The sample is intentionally narrow and centered on one scene script plus one API client.

### `Sam3dWorkspaceScene`

Responsibilities:

- build the floating XR panel,
- show status and prompt text,
- handle screenshot capture,
- handle speech prompt capture,
- handle manual prompt editing through XR keyboard,
- submit generation requests,
- poll jobs,
- load returned assets into `ModelViewer`,
- save/load/reset workspace state.

### `Sam3dApiClient`

Responsibilities:

- encapsulate local mock mode and HTTP backend mode,
- `POST /generate`,
- `GET /jobs/<jobId>`,
- `POST /workspaces/<workspaceId>/save`,
- `GET /workspaces/<workspaceId>`,
- allow `artifactHint` query param forwarding for mock testing.

### Asset Handling

The loaded asset is currently wrapped by `ModelViewer` and tracked as one active asset record with:

- `assetId`,
- `latentHandle`,
- `glbUrl`,
- `prompt`,
- `thumbnailUrl`,
- serialized transform matrix.

This is a good basis for later multi-asset workspace support.

## Current Backend Contract

The real VM backend should be made compatible with the frontend contract already used by the sample.

### Generate Request

Current frontend request shape:

```json
{
  "sessionId": "session-...",
  "workspaceId": "workspace-local",
  "prompt": "Generate this coffee mug",
  "image": {
    "mimeType": "image/png",
    "dataUrl": "data:image/png;base64,..."
  },
  "artifactHint": "pawn"
}
```

Notes:

- `artifactHint` is currently only for the mock backend and can be ignored by the real server.
- The real backend does not have to use `dataUrl` forever, but the current frontend sends this shape today.
- If the VM backend prefers raw base64 without the `data:` prefix, either the backend should parse it, or we should later revise the frontend and update this document.

### Generate Initial Response

Expected response:

```json
{
  "jobId": "job-001",
  "status": "queued",
  "sessionId": "session-...",
  "workspaceId": "workspace-local"
}
```

### Job Poll Response While Running

Expected running response:

```json
{
  "jobId": "job-001",
  "status": "running",
  "progress": 0.45,
  "message": "Encoding image and prompt"
}
```

### Job Poll Response On Completion

Expected completion response:

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
    "latentHandle": "latent-001",
    "metadata": {
      "prompt": "Generate this coffee mug"
    }
  }
}
```

This is the most important contract for the VM server to match.

Required fields for frontend compatibility:

- `jobId`
- `status`
- `asset.assetId`
- `asset.glbUrl`
- `asset.latentHandle`

Useful optional fields already supported by the frontend:

- `asset.thumbnailUrl`
- `asset.metadata.prompt`
- any extra metadata fields

### Save Workspace Request

Current frontend save payload:

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
        "latentHandle": "latent-001",
        "glbUrl": "https://.../model.glb",
        "prompt": "Generate this coffee mug",
        "thumbnailUrl": "data:image/png;base64,...",
        "transform": [1, 0, 0, 0, ...],
        "selections": []
      }
    ]
  }
}
```

Expected save response:

```json
{
  "workspaceId": "workspace-local",
  "savedAt": 1710000000000,
  "workspace": {
    "...": "..."
  }
}
```

### Load Workspace Response

Expected load response:

```json
{
  "workspaceId": "workspace-local",
  "savedAt": 1710000000000,
  "workspace": {
    "sessionId": "session-...",
    "prompt": "Generate this coffee mug",
    "lastScreenshotDataUrl": "data:image/png;base64,...",
    "assets": [
      {
        "assetId": "asset-001",
        "latentHandle": "latent-001",
        "glbUrl": "https://.../model.glb",
        "prompt": "Generate this coffee mug",
        "thumbnailUrl": "data:image/png;base64,...",
        "transform": [1, 0, 0, 0, ...],
        "selections": []
      }
    ]
  }
}
```

If the VM backend returns this shape, the current frontend can restore the workspace without structural changes.

## Current Mock Backend Behavior

The Python mock backend does the following today:

- exposes:
  - `POST /generate`
  - `GET /jobs/<jobId>`
  - `POST /workspaces/<workspaceId>/save`
  - `GET /workspaces/<workspaceId>`
  - `GET /healthz`
- simulates a delayed long-running generation job,
- returns synthetic `assetId` and `latentHandle`,
- returns a renderable remote model URL,
- writes request metadata JSON to disk,
- writes request images to disk,
- writes workspace JSON to disk,
- supports multiple mock artifact choices.

Current mock artifact support:

- `cat`
- `pawn`

Current selection behavior in the mock backend:

- none yet,
- selections are only saved as part of workspace JSON.

## Current Persistence Model

The frontend currently treats the backend as the preferred persistence layer when `backendUrl` is provided.

Current identity model:

- `sessionId`
  current frontend session id
- `workspaceId`
  stable workspace key, defaults to `workspace-local`
- `assetId`
  stable frontend/backend object id
- `latentHandle`
  backend-facing id for future editing / latent linkage

This identity model should be preserved on the real VM backend.

## Current Operational Commands

### Frontend

From repo root:

```bash
npm run dev
```

The repo's static server is configured with `Cache-Control: no-store`, which is important for Quest and desktop browser refresh reliability.

### Mock Backend

From repo root:

```bash
python samples/sam3d_workspace/server/main.py
```

Optional:

```bash
python samples/sam3d_workspace/server/main.py --job-delay 4
python samples/sam3d_workspace/server/main.py --default-artifact pawn
```

### Frontend URL

```text
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790
```

### Force Mock Artifact For Testing

```text
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790&artifactHint=cat
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790&artifactHint=pawn
```

### Quest Over USB

```bash
adb reverse tcp:8080 tcp:8080
adb reverse tcp:8790 tcp:8790
```

Then open the same frontend URL in Quest Browser.

## Current Risks And Constraints

### Passthrough Image Availability

Do not assume Quest Browser will provide true passthrough pixels in the captured screenshot.

### Speech Reliability

Do not assume Quest Browser speech transcription will work reliably.

### Browser-Based XR Limits

The current prototype is browser-based by design. That keeps iteration fast, but also means browser capability gaps are real product constraints until proven otherwise.

## Next Step For The Real VM Server

Tomorrow's server-side task should be:

1. implement the same HTTP shape as the current mock backend,
2. accept the frontend's current request payload,
3. create real long-running jobs,
4. expose `GET /jobs/<jobId>` polling,
5. return a real renderable `glbUrl`,
6. return stable `assetId` and `latentHandle`,
7. support workspace save/load using the current frontend payload shape.

The easiest way to succeed quickly is to make the VM backend match the already-working mock contract first, then iterate later.

In other words:

- do not redesign the frontend/backend contract tomorrow unless absolutely necessary,
- first make the real VM server look like the current Python mock backend from the frontend's perspective.

## After The Real Backend Is Connected

Once the real server works with the current frontend, the next major milestone should be selection.

Recommended next feature order:

1. connect real VM backend to existing sample,
2. verify real `glb` return path and workspace persistence,
3. prototype selection volume plus selection result data,
4. send selected indices plus transform to backend,
5. later support multi-asset recomposition.

## Selection Strategy For The Next Phase

Selection has not been implemented yet.

Recommended selection design remains:

- represent a visible `SelectionVolume`,
- compute a `SelectionResult` containing selected vertex indices,
- keep indices in asset-local coordinates,
- send transform separately as a 4x4 matrix,
- if a model contains multiple submeshes, store selections by submesh/node.

Suggested future shape:

```ts
type MeshSelection = {
  nodePath: string;
  vertexIndices: number[];
};
```

This is still the recommended phase-2 direction.

## Summary

What is already done:

- working Quest-compatible XR frontend sample,
- working screenshot flow,
- working manual prompt fallback,
- working job-based backend polling flow,
- working asset loading and manipulation,
- working backend-backed save/load,
- working Python mock backend,
- working mock multi-artifact switching.

What is not done yet:

- true passthrough-inclusive capture,
- reliable headset speech transcription,
- mesh selection pipeline,
- real SAM3D backend integration,
- multi-asset part recomposition.

The correct immediate focus is the real VM backend integration, using the current mock backend contract as the compatibility target.
