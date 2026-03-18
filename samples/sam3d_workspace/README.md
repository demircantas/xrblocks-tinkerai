# SAM3D Workspace Sample

Phase-1 scaffold for the SAM3D XR workflow described in
[`docs/sam3d-xr-strategy.md`](../../docs/sam3d-xr-strategy.md).

## Current Scope

This sample is intentionally narrow. It validates:

- screenshot capture from XR,
- prompt capture through speech recognition,
- visible microphone capability diagnostics,
- a job-based generation flow,
- loading a returned model into an editable `ModelViewer`,
- and save/load of a single asset record.

## Modes

The sample supports two backend modes.

### Frontend-Only Mock

This is still the default if no backend URL is provided.

- `Generate` creates a local mock job.
- The job is polled until completion.
- The completed job returns a mock asset payload with:
  - `assetId`
  - `glbUrl`
  - `latentHandle`
  - `workspaceId`
- `Save Workspace` and `Load Workspace` use browser `localStorage`.

Open:

```text
http://localhost:8080/samples/sam3d_workspace/
```

### Python Mock Backend

A local mock backend now lives in
[`samples/sam3d_workspace/server`](./server/README.md).

It exposes:

- `POST /generate`
- `GET /jobs/<jobId>`
- `POST /workspaces/<workspaceId>/save`
- `GET /workspaces/<workspaceId>`
- `GET /healthz`

Start it in a separate terminal:

```bash
python samples/sam3d_workspace/server/main.py
```

Then open the sample with `backendUrl`:

```text
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790
```

For Quest over USB, also reverse the backend port:

```bash
adb reverse tcp:8790 tcp:8790
```

## Run

Serve the repository from the root:

```bash
npm run dev
```

The local static server now uses `Cache-Control: no-store`, which helps headset and desktop browsers pick up JS/UI changes reliably.

## Helpful URL Params

- `prompt`
  Sets the initial prompt text.
- `mockDelayMs`
  Controls the local frontend mock generation delay.
- `mockModelUrl`
  Overrides the model URL returned by the local scaffold client.
- `workspaceId`
  Overrides the workspace ID.
- `backendUrl`
  Switches the sample from the local mock client to the Python mock backend.
- `artifactHint`
  Forces the Python mock backend to return a specific test model such as `cat` or `pawn`.
- `overlayOnCamera`
  Requests camera-overlay screenshot behavior when available.

Example frontend-only mock URL:

```text
http://localhost:8080/samples/sam3d_workspace/?prompt=Generate%20this%20lamp&mockDelayMs=8000
```

Example backend URL:

```text
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790&workspaceId=demo-workspace&artifactHint=pawn
```

## Notes

- The Python backend stores generation request metadata and saved workspaces under `samples/sam3d_workspace/server/data/`.
- The mock backend returns a stable asset contract with `assetId`, `glbUrl`, `thumbnailUrl`, `latentHandle`, and `metadata.prompt`.
- This keeps the frontend aligned with the intended SAM3D server contract before the real backend exists.



