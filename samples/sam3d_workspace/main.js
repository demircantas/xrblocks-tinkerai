import 'xrblocks/addons/simulator/SimulatorAddons.js';

import * as xb from 'xrblocks';

import {Sam3dWorkspaceScene} from './Sam3dWorkspaceScene.js';

document.addEventListener('DOMContentLoaded', async () => {
  const options = new xb.Options();
  options.enableCamera('environment');
  options.permissions.microphone = true;
  options.controllers.visualizeRays = true;
  options.sound.speechRecognizer.enabled = true;
  options.sound.speechRecognizer.interimResults = true;
  options.sound.speechRecognizer.playSimulatorActivationSounds = true;
  options.depth.enabled = true;
  options.depth.depthMesh.enabled = true;
  options.depth.depthMesh.updateFullResolutionGeometry = true;
  options.reticles.enabled = true;
  options.xrButton.showEnterSimulatorButton = true;
  options.setAppTitle('SAM3D Workspace');
  options.setAppDescription(
    'Phase-1 scaffold for screenshot capture, prompt input, job-based generation, and editable asset placement.'
  );

  xb.add(new Sam3dWorkspaceScene());
  await xb.init(options);
});
