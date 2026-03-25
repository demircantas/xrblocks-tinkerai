import 'xrblocks/addons/simulator/SimulatorAddons.js';

import * as xb from 'xrblocks';

import {Sam3dWorkspaceScene} from './Sam3dWorkspaceScene.js';

document.addEventListener('DOMContentLoaded', async () => {
  const options = new xb.Options();
  const params = new URL(window.location.href).searchParams;
  const enableRockGestureRecall = params.get('enableRockGestureRecall') === 'true';
  options.controllers.visualizeRays = true;
  options.sound.speechRecognizer.enabled = true;
  options.sound.speechRecognizer.interimResults = true;
  options.sound.speechRecognizer.playSimulatorActivationSounds = true;
  options.reticles.enabled = true;
  options.xrButton.showEnterSimulatorButton = true;
  options.enableCamera('environment');
  if (enableRockGestureRecall) {
    options.enableHands();
  }
  options.setAppTitle('SAM3D Workspace');
  options.setAppDescription(
    'Workspace refactor for screenshot capture, prompt input, backend generation, and multi-asset placement.'
  );

  xb.add(new Sam3dWorkspaceScene());
  await xb.init(options);
});
