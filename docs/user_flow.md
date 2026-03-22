# This document describes the intended flow during the user study.
## Current behavior / debug mode
We currently have three UI panels with multiple buttons and feedback areas. We will keep this unchanged as a debug mode that is accessed using a variable `?debugUi=true` on the fronted URL.
In the user-facing flow, we will use functions that are mapped to buttons from the debug UI.
We will later build a flat screen debug interface for running the current debug commands from a browser during the study.

## Intended user-facing behavior
We treat all actions as a fixed sequence of modes, `generate`, `segment`, `compose`.

### Generate mode
The XR frontend starts from the `generate` mode. Here, the user has a "push-to-talk" button (`record` button in the debug UI) for speech input. They are instructed to ask the tool to generate an object that they are looking at. Example: "Generate this coffee mug" while looking at a coffee mug in front of them. This command takes a screenshot, exactly the same way the current `capture` button works in the debug UI. The tool should show the user their prompt and ask them if they are sure. If the user states they are sure, the tool should proceed and pass the transcribed speech and screenshot with the `generate` button from the debug UI. There should be text feedback showing generation state as is shown in the debug UI. If the user states that they are not sure, the tool should provide feedback that the prompt was cancelled and urge the user to "push-to-talk" for a new try.
Once a user generates an object, they can repeat the flow to generate more objects.
Once ready, they will click a `next` button that asks them which models they want to keep.

### Segment mode
Once the `generate` mode is concluded, the tool moves on to `segment` mode. Here the user is presented with each model that they generated in `generate` mode and are asked to use the selection tool to highlight which parts of the mesh they want to keep and remove. This corresponds to the `select:off/on` button in selection tools of the debug UI. The users will have a button that works exactly as `mode:drop / keep`. We will have partial mesh preview as default and possibly have the option to view full temporarily.
Once the user makes a selection, they will hit `next` to make a selection on the next object until they complete selection on all objects. There should also be a `previous` button to allow the user to go back to a previous asset and modify their selections.
We also want buttons `save / load selection` that uses the ability to save and load workspaces from the backend. The tool should save a new workspace when the user completes generate mode and enters segment mode, and should overwrite the existing workspace when the user hits save.
When the user is done with the `segment` mode, the tool should save the workspace and move on to `compose` mode.

### Compose mode
In compose mode, the user will move, rotate and scale objects in a sequence. We will only allow the user to transform the first mesh until they hit the `next` button which will allow them to only move the second object and so on. We will also have a `previous` button to allow the user to return to the previous object if they wish to make changes. Once the user is satisfied, they will hit the `compose` button which will save the workspace and invoke a `compose` request over the saved workspace. Here, we should provide text feedback for the decoding process from the backend, similar to what we currently show on the debug UI.
The user can transform the composed asset and if the want, they can use the `previous` and `next` buttons to go back to transforming objects. If they hit `compose` again, the tool will run another compose request and replace the result of the last compose with the new one.
