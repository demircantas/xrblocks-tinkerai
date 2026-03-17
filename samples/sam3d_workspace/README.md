# SAM3D Workspace Sample

Phase-1 scaffold for the SAM3D XR workflow described in
[`docs/sam3d-xr-strategy.md`](../../docs/sam3d-xr-strategy.md).

## Current Scope

This sample is intentionally narrow. It validates:

- screenshot capture from XR,
- prompt capture through speech recognition,
- a job-based generation flow,
- loading a returned model into an editable `ModelViewer`,
- and temporary save/load of a single asset record.

## Current Implementation

The sample currently uses a frontend scaffold client instead of a real backend.

- `Generate` creates a mock job.
- The job is polled until completion.
- The completed job returns a mock asset payload with:
  - `assetId`
  - `glbUrl`
  - `latentHandle`
  - `workspaceId`
- `Save Workspace` and `Load Workspace` use browser `localStorage`.

This keeps the sample useful before the Python mock backend exists.

## Run

Serve the repository from the root:

```bash
npm run dev
```

Open:

```text
http://localhost:8080/samples/sam3d_workspace/
```

## Helpful URL Params

- `prompt`
  Sets the initial prompt text.
- `mockDelayMs`
  Controls the mock generation delay.
- `mockModelUrl`
  Overrides the model URL returned by the scaffold client.
- `workspaceId`
  Overrides the scaffold workspace ID.

Example:

```text
http://localhost:8080/samples/sam3d_workspace/?prompt=Generate%20this%20lamp&mockDelayMs=8000
```

## Next Step

Replace the scaffold client with a Python mock backend that exposes:

- `POST /generate`
- `GET /jobs/:jobId`
- `POST /workspaces/:workspaceId/save`
- `GET /workspaces/:workspaceId`
