# Frontend Pose Debug Handoff

## Purpose

This note is for the frontend agent working on XR Blocks workspace save/load and compose.

The current backend reached a good milestone for:

- generation
- asset/workspace persistence
- workspace-driven compose

But there is still an unresolved pose/frame issue that appears to be frontend-owned and device-sensitive.

## Current Conclusion

We previously added a backend compatibility patch that tried to mimic the XR Blocks `ModelViewer` local content layout during compose:

- scale `0.9`
- horizontal recentering
- vertical grounding

That patch fixed one compose offset case temporarily, but it also created hidden coupling between backend compose and frontend presentation behavior.

That coupling is not a good long-term contract.

The backend compatibility patch is still present but gated behind:

```python
ENABLE_FRONTEND_MODELVIEWER_LAYOUT_COMPAT = False
```

in:

- [xr_svc.py](/home/farazfaruqi/sam-3d-objects/desktop-exp/backend/services/xr_svc.py)

It is `false` by default.

The backend now also defaults to the least opinionated compose path:

- `composeMode: "notebook_v1"`
- `projectionMode: "nearest"`

The intent is to keep backend-side pose reinterpretation minimal and push frame stability to the frontend.

## Why We Believe This Is Frontend-Side

The key new observation is:

- vertical offsets were seen even when simply loading saved workspaces on a new Galaxy XR headset

That is more important than the compose-specific symptoms.

If `save -> load workspace` already changes apparent object height, then compose is not the root cause.

It means the saved transform contract is not stable across:

- frontend load path
- wrapper/content transforms
- or device/reference-frame behavior

## Backend Findings

We checked the backend compose inputs carefully.

What is true:

- saved workspace transforms are being read correctly
- source asset references are correct
- for compose, transformed source mesh centers and transformed latent centers can be made to match before decode

What is still not trustworthy:

- whether the frontend-visible object pose is actually the same as the raw backend mesh pose that `transformMatrix` is being interpreted against

We also found that the XR Blocks sample saves transforms on the `xb.ModelViewer` wrapper, not on the raw GLB mesh.

And `ModelViewer` internally modifies loaded content via `setupBoundingBox(...)`, including:

- recentering
- grounding
- content-relative shifts

So the same saved wrapper transform can correspond to different visible mesh poses if the internal content layout changes or is device-dependent.

## Requested Frontend Investigation

Please debug pose consistency independently of compose.

### Minimal reproduction

Use a single generated asset and test:

1. generate asset
2. move asset to a clearly non-default pose
3. save workspace
4. reload the same workspace
5. compare visible pose before and after reload

Do this on:

- desktop/simulator
- Quest if available
- Galaxy XR

### Questions to answer

We need concrete answers to these:

1. Is `transformMatrix` identical before save and after load?
2. Is the visible mesh pose identical before save and after load?
3. Is the object being transformed on the wrapper, while the visible GLB content is shifted internally after load?
4. Does `ModelViewer.loadGLTFModel()` produce the same internal child layout on all target devices?
5. Is there any headset-specific world/floor/reference-space offset getting mixed into saved workspace transforms?

## Specific Code Area To Audit

Current XR Blocks sample patterns that matter:

- transforms are saved from the wrapper object matrix
- loaded GLB content is added inside `ModelViewer`
- `ModelViewer.setupBoundingBox(...)` recenters/grounds content after load

That means the frontend should confirm whether the saved transform is really the canonical asset pose, or only the wrapper pose.

## Recommended Frontend Direction

The better long-term contract is:

- save transforms in a frame that is explicitly defined and stable
- avoid hidden presentation/layout transforms affecting persisted pose semantics
- make frontend-authored transforms the only pose authority the backend must trust

Practically, one of these should become true:

1. The frontend stores the transform of the actual normalized content frame, not only the outer wrapper.
2. The frontend persists the wrapper transform plus explicit content-layout metadata.
3. The frontend removes or standardizes hidden content recentering/grounding so saved transforms have stable meaning.

The preferred direction is `1` or `3`. The backend should not keep learning frontend-specific grounding or recentering rules.

## Current Backend Contract

The backend is now intentionally conservative:

- default compose path is `notebook_v1`
- default projection is strict `nearest`
- `ENABLE_FRONTEND_MODELVIEWER_LAYOUT_COMPAT` remains `False`

This means the frontend should assume:

- backend compose will not try to mimic `ModelViewer` layout behavior
- backend compose expects saved transforms to already describe the intended authored pose
- if frontend loading applies hidden recentering, grounding, or device-dependent child transforms, compose correctness will drift

## Backend Status

The backend is intentionally no longer masking this by default.

Current state:

- backend compose defaults to `notebook_v1` with `nearest` projection
- backend compose runs with `ENABLE_FRONTEND_MODELVIEWER_LAYOUT_COMPAT = False`
- the legacy `xr_v1` path still exists only as a debugging comparison path
- the preferred fix remains frontend-side pose/frame stabilization

## Immediate Next Step

Before more compose/color tuning, please confirm whether:

- `save -> load workspace` preserves visible object pose exactly on Galaxy XR
- the pose seen by the user is the same pose represented by the saved `transformMatrix`

If not, fix that on the frontend first.
