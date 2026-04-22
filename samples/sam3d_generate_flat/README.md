# SAM3D Flatscreen Generate

Minimal desktop webpage for sending an image and prompt to the SAM3D backend,
polling the generation job, previewing the resulting model, and downloading the
returned GLB.

## Run

Start the static sample server as usual, then open:

```text
http://localhost:8080/samples/sam3d_generate_flat/?backendUrl=http://localhost:8790
```

Optional URL parameters:

- `backendUrl`: backend server base URL. Defaults to `http://localhost:8790`.
- `workspaceId`: workspace id sent with the request.
- `sessionId`: session id sent with the request.
- `artifactHint`: optional artifact hint passed through to `/generate`.
- `prompt`: optional initial prompt text.

## Backend Contract

The page sends:

```text
POST /generate
```

with:

```json
{
  "sessionId": "...",
  "workspaceId": "...",
  "prompt": "...",
  "image": {
    "mimeType": "image/png",
    "dataUrl": "data:image/png;base64,..."
  },
  "artifactHint": "optional"
}
```

Then it polls:

```text
GET /jobs/{jobId}
```

When the job completes, it expects the completed job payload to include an
asset with a model URL, preferably:

```json
{
  "status": "completed",
  "asset": {
    "assetId": "asset-id",
    "glbUrl": "http://localhost:8790/assets/asset-id/model.glb"
  }
}
```
