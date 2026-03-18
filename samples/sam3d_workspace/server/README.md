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
python samples/sam3d_workspace/server/main.py --default-artifact pawn
```

## Endpoints

- `POST /generate`
- `GET /jobs/<jobId>`
- `POST /workspaces/<workspaceId>/save`
- `GET /workspaces/<workspaceId>`
- `GET /healthz`

## Artifact Selection

The mock backend can return different test models.

Available artifact keys:

- `cat`
- `pawn`

Selection rules:

- `artifactHint` in the request takes priority.
- Otherwise the backend uses prompt keywords.
- Otherwise it falls back to `--default-artifact`.

Current prompt keyword examples:

- `cat`, `kitten`, `feline` -> `cat`
- `pawn`, `chess`, `piece`, `mug`, `coffee`, `cup` -> `pawn`

## Frontend

Open the sample with:

```text
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790
```

To force a specific returned model for testing:

```text
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790&artifactHint=cat
http://localhost:8080/samples/sam3d_workspace/?backendUrl=http://localhost:8790&artifactHint=pawn
```

For Quest over USB:

```bash
adb reverse tcp:8790 tcp:8790
```

Then open the same frontend URL on the headset.

## Notes

- Requests and saved workspaces are mirrored to `server/data/` for debugging.
- The selected artifact key is stored alongside each generation request JSON.
- `GET /healthz` now reports the available artifact keys.
