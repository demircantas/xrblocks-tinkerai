# Tool Description: Frontend

## Purpose

This document describes the frontend tool implemented in the `sam3d_workspace` sample. It is written as a paper-oriented description of what the tool does, how users interact with it, and how it connects to backend services.

At a high level, the tool is an XR workspace for:

- capturing the user's physical environment through passthrough screenshots,
- collecting textual prompts through speech or typed input,
- generating 3D assets from those inputs,
- editing those assets through mesh selection and spatial transforms,
- composing multiple generated assets into a new combined 3D result, and
- comparing this native 3D workflow against an image-first Nano Banana baseline.

The frontend is built on top of `xrblocks` and is designed for headset-based mixed reality use, while still supporting a flat-screen simulator mode for development.

## Frontend Scope

The frontend is responsible for:

- XR scene setup and UI rendering,
- screenshot capture from the headset camera,
- speech recognition and keyboard fallback,
- loading and displaying generated meshes,
- brush-based part selection on meshes,
- object transforms through an in-scene gizmo,
- managing local workspace state,
- submitting long-running generation and compose jobs to the backend, and
- polling and loading queued job results.

The frontend is not responsible for:

- 3D generation itself,
- Nano Banana image generation itself,
- backend latent composition,
- segmentation mask extraction,
- or model decoding.

Those operations are delegated to backend services, while the frontend acts as the interaction layer and local state manager.

## Main Frontend Entry Points

The main implementation is centered around the following files:

- `samples/sam3d_workspace/main.js`
- `samples/sam3d_workspace/Sam3dWorkspaceScene.js`
- `samples/sam3d_workspace/Sam3dApiClient.js`
- `samples/sam3d_workspace/MeshSelectionController.js`
- `samples/sam3d_workspace/TransformGizmoController.js`

Their roles are:

- `main.js`: initializes `xrblocks`, enables environment camera access, enables speech recognition, and optionally enables hand tracking.
- `Sam3dWorkspaceScene.js`: the main application controller, scene graph owner, UI manager, and workflow state machine.
- `Sam3dApiClient.js`: frontend wrapper around backend routes for generation, composition, jobs, workspaces, and Nano Banana requests.
- `MeshSelectionController.js`: mesh brush selection logic and selection visualization.
- `TransformGizmoController.js`: translation / rotation / scale gizmo logic for manipulating assets in the scene.

## Runtime Modes and URL Flags

The tool currently supports multiple runtime shells and feature flags.

### UI shells

- Default: participant-facing SAM3D workflow
- `?debugUi=true`: operator/debug UI
- `?baselineUi=nanobanana`: Nano Banana baseline workflow

### Additional flags

- `?keyboardPromptInput=true`: use Bluetooth keyboard input instead of speech in guided prompt flows
- `?enableDevUiSwitch=true`: allow runtime switching between debug and flow shells
- `?enableRockGestureRecall=true`: opt-in experimental hand-gesture recall path

These flags allow the same codebase to support both participant-facing studies and researcher/operator workflows.

## Overall Interaction Model

The frontend is organized around guided stages instead of exposing all controls at once.

There are two main participant-facing workflows:

1. The native SAM3D workflow
2. The Nano Banana baseline workflow

Both are implemented as stage-based finite-state flows with persistent session state.

## Workflow 1: Native SAM3D Flow

The main workflow follows three stages:

1. `generate`
2. `segment`
3. `compose`

This flow is designed to support direct object capture from the user's environment, editing of retained mesh regions, and spatial composition of multiple generated objects.

### Stage 1: Generate

In generate mode, the user creates 3D assets from the real scene.

The intended pattern is:

1. capture the current scene with `Capture Screen`,
2. provide a prompt by speech or keyboard,
3. review the captured prompt,
4. confirm or cancel,
5. wait for backend generation,
6. receive the resulting 3D asset directly into the workspace.

Generate mode supports repeated use, so a user can create multiple objects in sequence before moving on.

The UI also supports:

- `Previous` / `Next` asset navigation,
- `Delete Asset`,
- `Reset`, which brings the active asset to the current hand,
- prompt confirmation,
- and queued status feedback for generation jobs.

### Stage 2: Segment

Segment mode lets the user specify which parts of each generated mesh should be kept.

The workflow is:

1. move through assets one at a time,
2. enable selection mode,
3. paint keep/discard regions with a brush,
4. inspect the kept-only preview,
5. move to the next or previous asset.

The mesh selection tool is brush-based and vertex-driven. The frontend stores selected vertex indices and sends those to the backend as the canonical selection state.

Segment mode includes:

- `Select: ON/OFF`
- `Mode: Keep/Drop`
- brush size controls with preset sizes
- `Previous` / `Next`
- `Delete Asset`
- `Reset`
- transition back to generate or forward to compose

Selection is deliberately non-destructive at the frontend geometry level. The selected vertices are stored as edit state, and the backend later uses them for mesh filtering and latent propagation.

### Stage 3: Compose

Compose mode lets the user arrange generated assets in 3D space and then request a composed result from the backend.

The user can:

- select assets sequentially,
- move, rotate, and scale them with the transform gizmo,
- duplicate an asset,
- delete an asset,
- reset an asset to the hand,
- and submit a compose request.

Once a composed result returns from the backend, it is treated as another workspace asset. The user can continue transforming it, compose again, or move backward in the flow.

This stage is the culmination of the native workflow:

- `generate` creates object assets,
- `segment` refines which parts of each asset matter,
- `compose` arranges them and asks the backend to decode a final combined result.

## Workflow 2: Nano Banana Baseline

The baseline workflow is a separate image-first comparison condition enabled with `?baselineUi=nanobanana`.

It uses three different stages:

1. `reference-generate`
2. `composite`
3. `3d`

This baseline was introduced to compare the native 3D-first workflow against a workflow in which the user first generates 2D images, then composes those images, and only then converts the final image into 3D.

### Baseline Stage 1: Reference Generate

In this stage, the user:

1. captures a screenshot of the real scene,
2. describes an object of interest,
3. confirms the prompt,
4. sends screenshot plus prompt to the Nano Banana backend route,
5. receives one or more generated reference images.

Multiple reference images can be generated and retained in session state.

The current implementation uses prompt conditioning so that the backend is asked to isolate the requested object from a busy real-world scene and produce a single clean object on a neutral gray background. This makes the generated images more suitable for later mask extraction and 3D generation.

### Baseline Stage 2: Composite

In composite mode, the remaining reference images are treated as the image set to be composed together.

The user:

1. reviews the retained reference images,
2. removes any unwanted images with `Delete Image`,
3. records a new prompt describing the desired arrangement,
4. optionally appends more spoken prompt detail with `Add Prompt`,
5. confirms the combined prompt,
6. sends prompt plus all retained reference images to Nano Banana again,
7. receives a composite image.

The selected reference images are shown in the UI so the user can see what will be used during composition.

### Baseline Stage 3: 3D

After the user is satisfied with a composite image, `To 3D` forwards the active composite image into the normal SAM3D generation route.

The result is a 3D asset that enters the workspace as a normal mesh. In this baseline 3D stage, the user can:

- move through generated meshes with `Previous Mesh` / `Next Mesh`,
- delete meshes,
- reset the active mesh to the current hand,
- and manipulate the mesh using the same transform gizmo used in the native flow.

This design makes the final comparison legible:

- native flow: direct 3D generation, selection, and composition
- baseline flow: image generation, image composition, then 3D conversion

## Prompt Capture and Confirmation

The tool supports two prompt input modalities in guided flows:

- speech recognition,
- Bluetooth keyboard fallback.

### Speech input

Speech input uses the `xrblocks` speech recognizer. The user enters prompt capture through a button such as `Push To Talk`. When recognition completes, the recognized text is shown back to the user for confirmation.

The user can then:

- `Confirm`
- `Cancel`
- `Re-record`

In Nano Banana baseline flows, the user can also choose:

- `Add Prompt`

`Add Prompt` starts another listening pass and appends the additional transcript to the existing prompt rather than replacing it.

### Keyboard fallback

When `?keyboardPromptInput=true` is used, guided prompt stages accept Bluetooth keyboard input instead of speech. The user types directly, and:

- `Enter` finishes prompt entry,
- `Enter` confirms during the confirmation step,
- `Escape` cancels current prompt entry or confirmation.

This fallback was added for deployments in which speech recognition is unreliable or impractical.

## Screenshot Capture

Screenshot capture is deliberately separated from prompt capture.

The participant-facing flows use a dedicated `Capture Screen` button that waits one second before taking the screenshot. This gives the user time to frame the scene while keeping the action explicit and legible.

The frontend tries to capture from the headset device camera first, so the screenshot includes passthrough imagery. If that path fails, the system falls back to a renderer-based screenshot, although the intended behavior is the device-camera path.

The recent implementation history also showed an important practical constraint:

- passthrough screenshot capture can fail if multiple instances of the app are open in separate browser tabs.

In practice, reliable capture is achieved when only one active app instance is open.

## Asset Representation and Transform Ownership

One of the major frontend design constraints in this project is transform correctness.

Earlier iterations mixed user-authored transforms with hidden viewer normalization logic. That created pose mismatches during composition. The current frontend instead uses an explicit authored transform contract.

### Current transform ownership model

Each asset is represented with at least two conceptual layers:

- an authored root, which is the persistent transform owner,
- a visible loaded scene beneath it.

The important rule is:

- the authored root is the only pose sent to the backend.

This means:

- saved `transformMatrix` values come from the authored root,
- compose requests use the authored root transform,
- the transform gizmo edits the authored root,
- transient viewer behavior must not redefine backend-facing pose.

This wrapper-based design is critical because the backend compose path assumes the frontend-authored homogeneous transform is authoritative.

## Transform Gizmo

The transform gizmo is implemented in `TransformGizmoController.js`.

It supports:

- translation,
- axis rotation,
- scaling,
- XR direct-grab interaction,
- visual hover feedback,
- opacity changes based on proximity.

The gizmo is rendered semi-transparently when idle and becomes more opaque when the user's hand or controller is close enough to interact with it.

It is used in:

- native compose mode,
- Nano Banana baseline 3D mode.

The gizmo controller operates directly on the authored asset root, not on child meshes or helper geometry.

## Mesh Selection System

The mesh selection system is implemented in `MeshSelectionController.js`.

The user can toggle selection on an asset and then paint over regions to mark them for `keep` or `drop`.

### Selection semantics

The frontend stores:

- selected vertex indices,
- selection mode,
- per-asset selection state.

The backend later interprets these selections by:

- filtering faces based on selected vertices,
- propagating from selected mesh vertices to latent voxels.

This preserves a clean contract:

- frontend decides which visible mesh regions matter,
- backend derives latent-space keep sets from that mesh selection.

### Brush behavior

The selection brush currently includes:

- preset brush sizes,
- idle preview spheres for both hands,
- stroke visualization during pinch,
- delayed selection application on release.

A key design decision is that the expensive selection solve should happen only when the user completes a stroke, not continuously while hovering. Recent refactors made the idle preview much lighter by replacing per-frame rebuild logic with dedicated hand-following preview spheres.

## Object Management Features

The workspace supports several operations beyond generation and composition.

### Per-asset controls

Across the guided flows, users can:

- navigate assets with `Previous` / `Next`,
- delete the active asset,
- duplicate the active asset,
- reset the active asset to the user's hand,
- transform the active asset with the gizmo.

These features are important for fast iteration during study tasks and for correcting positioning mistakes without restarting the workflow.

### Scaling behavior

Newly imported/generated assets are intentionally brought into the scene at a reduced default scale so they are easier to inspect and manipulate in the workspace.

## Backend Communication Model

All long-running backend operations use a job-based pattern.

The frontend submits a request, receives a `jobId`, and then polls until completion.

This pattern is used for:

- XR 3D generation,
- XR compose,
- Nano Banana reference generation,
- Nano Banana composite generation,
- Nano Banana-to-3D handoff.

### API client responsibilities

`Sam3dApiClient.js` wraps the main backend routes, including:

- `POST /generate`
- `POST /baseline/nanobanana/generate`
- `POST /workspaces/{workspaceId}/compose`
- `GET /jobs/{jobId}`
- `GET /jobs`
- workspace save/load endpoints

The client also has a local mock mode for development when no backend is configured.

## Queued Job Handling

The frontend was explicitly adapted to support multiple queued jobs.

This became necessary once the backend started queueing requests instead of rejecting overlapping requests.

### Current behavior

The frontend now:

- tracks multiple pending jobs at once,
- polls both individual job ids and the global job list,
- displays queue-related status,
- loads completed results directly from the completed job payload,
- handles completed results exactly once,
- deduplicates assets and Nano Banana images to avoid repeated loading.

This is important for stability because users may submit several generation or compose requests in sequence.

Without deduplication, the same result could temporarily disappear and reload, which feels glitchy in XR.

## Workspace State

The frontend keeps a live local workspace model representing:

- loaded assets,
- active asset index,
- transform state,
- per-asset selections,
- flow stage,
- prompt state,
- screenshot state,
- pending job state,
- Nano Banana reference results,
- Nano Banana composite results.

This local state makes the frontend responsive and allows the scene to be updated immediately as backend jobs complete.

## Debug UI vs Guided UI

The tool intentionally contains both:

- a participant-facing guided workflow,
- an operator/debug interface.

### Guided UI

The guided UI is designed for user studies and task clarity. It exposes only the current stage-relevant actions and hides development-heavy controls.

### Debug UI

The debug UI preserves direct access to lower-level controls and is useful for:

- testing backend routes,
- debugging asset state,
- comparing behaviors,
- recovering from unexpected study conditions,
- and running development experiments.

This separation is methodologically useful because the guided participant experience can remain stable while the research team still has access to lower-level tooling.

## Research-Oriented Design Rationale

Several frontend design decisions were made specifically to support research use rather than generic product polish.

### 1. Stage-based flows

Both the native SAM3D workflow and the Nano Banana baseline are expressed as explicit staged procedures. This makes the user experience easier to explain and helps preserve study consistency.

### 2. Hidden debug/operator shell

The study-facing interface can stay simple, while developers retain access to more direct controls when needed.

### 3. Conditioned baseline prompts

The Nano Banana baseline is not used as a free-form image generation tool. The frontend deliberately conditions prompts to create clean gray-background object images so that later backend mask extraction and 3D generation are more reliable.

### 4. Authoritative frontend transforms

The frontend treats the authored object transform as a contract with the compose backend. This was a major design correction made to avoid geometry and projection mismatches.

### 5. Explicit queue handling

The frontend assumes that multiple requests may overlap in time and therefore presents queued, running, and completed job states as first-class interaction states.

## Practical Notes and Known Limitations

The current implementation is functional and study-ready, but several practical constraints remain relevant for a paper description.

### 1. Browser-instance sensitivity of passthrough capture

Passthrough screenshot capture works reliably when a single app instance is open. Running multiple tabs of the app can interfere with that capture path.

### 2. Panel dragging remains imperfect

The UI supports movable panels in debug-oriented contexts, but drag interactions were a recurring source of inconsistency because panel dragging and button selection compete inside the underlying UI framework. The current baseline favors working buttons and working workflows over perfect panel-drag behavior.

### 3. XR interaction required careful simplification

Several experimental interaction paths, such as gesture-based object recall or overly heavy preview logic, were removed or simplified because they imposed unnecessary runtime cost or reduced predictability in XR.

### 4. Baseline and native flows intentionally differ

The two workflows are not just visual variants of the same UI. They represent distinct interaction philosophies:

- direct 3D manipulation,
- versus image-first ideation followed by 3D conversion.

That difference is intentional and is part of the research design.

## Summary

The frontend tool is an XR mixed-reality workspace for capturing real-world context, generating 3D assets, refining them through mesh selection, and composing them spatially. It also includes a separate image-first Nano Banana baseline for controlled comparison.

The system combines:

- headset screenshot capture,
- speech and keyboard prompt entry,
- multi-stage guided workflows,
- backend job orchestration,
- brush-based mesh editing,
- gizmo-based spatial manipulation,
- and careful transform handling for backend composition.

Its current form is best understood as a research interaction platform rather than a generic end-user product: it is built to support controlled study procedures, compare alternative creative pipelines, and keep frontend-authored state aligned with backend 3D processing.
