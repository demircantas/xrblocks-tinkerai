# SAM3D Mock Backend

Small dependency-free Python mock backend for the
`samples/sam3d_workspace/` frontend.

## Run

From the repo root:

```bash
python samples/sam3d_workspace/server/main.py
```

Optional flags:

```bash
python samples/sam3d_workspace/server/main.py --port 8790 --job-delay 15
```

## Endpoints

- `POST /generate`
- `GET /jobs/<jobId>`
- `POST /workspaces/<workspaceId>/save`
- `GET /workspaces/<workspaceId>`
- `GET /healthz`

## Frontend

Open the sample with:

```text
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790
```

For Quest over USB:

```bash
adb reverse tcp:8790 tcp:8790
```

Then open the same frontend URL on the headset.

## Notes

- Requests and saved workspaces are mirrored to `server/data/` for debugging.
- The server returns a static sample model URL by default.
- `--artifact-url` can be used to point at a different test model.
