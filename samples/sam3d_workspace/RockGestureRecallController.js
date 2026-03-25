import {loadLiteRt, setWebGpuDevice} from '@litertjs/core';
import {runWithTfjsTensors} from '@litertjs/tfjs-interop';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import * as xb from 'xrblocks';

const LEFT_HAND_INDEX = 0;
const RIGHT_HAND_INDEX = 1;
const UNKNOWN_GESTURE = 8;
const ROCK_GESTURE = 6;

export class RockGestureRecallController {
  constructor({onRecall = () => {}, onStatus = () => {}} = {}) {
    this.onRecall = onRecall;
    this.onStatus = onStatus;
    this.modelPath = '../gestures_custom/custom_gestures_model.tflite';
    this.model = null;
    this.modelState = 'idle';
    this.frameId = 0;
    this.enabled = true;
    this.isProcessing = false;
    this.wasRocking = [false, false];
    this.hasReportedLoadFailure = false;
  }

  init() {
    if (this.modelState !== 'idle') return;
    this.modelState = 'loading';
    setTimeout(() => {
      this.setBackendAndLoadModel();
    }, 1);
  }

  dispose() {
    this.enabled = false;
    this.model = null;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  async setBackendAndLoadModel() {
    try {
      await tf.setBackend('webgpu');
      await tf.ready();
      const wasmPath = 'https://unpkg.com/@litertjs/core@0.2.1/wasm/';
      const liteRt = await loadLiteRt(wasmPath);
      const backend = tf.backend();
      setWebGpuDevice(backend.device);
      this.model = await liteRt.loadAndCompile(this.modelPath, {
        accelerator: 'webgpu',
      });
      this.modelState = 'ready';
    } catch (error) {
      this.modelState = 'error';
      console.error('Failed to initialize rock gesture recall.', error);
      if (!this.hasReportedLoadFailure) {
        this.hasReportedLoadFailure = true;
        this.onStatus('Rock gesture recall is unavailable.');
      }
    }
  }

  calculateRelativeHandBoneAngles(jointPositions) {
    const jointPositionsReshaped = jointPositions.reshape([xb.HAND_JOINT_COUNT, 3]);
    const boneVectors = [];
    xb.HAND_JOINT_IDX_CONNECTION_MAP.forEach(([joint1, joint2]) => {
      const boneVector = jointPositionsReshaped
        .slice([joint2, 0], [1, 3])
        .sub(jointPositionsReshaped.slice([joint1, 0], [1, 3]))
        .squeeze();
      const norm = boneVector.norm();
      const normalizedBoneVector = boneVector.div(norm);
      boneVectors.push(normalizedBoneVector);
    });

    const relativeHandBoneAngles = [];
    xb.HAND_BONE_IDX_CONNECTION_MAP.forEach(([bone1, bone2]) => {
      const angle = boneVectors[bone1].dot(boneVectors[bone2]);
      relativeHandBoneAngles.push(angle);
    });

    return tf.stack(relativeHandBoneAngles);
  }

  async detectGesture(handJoints) {
    if (!this.model || !handJoints || handJoints.length !== 25 * 3) {
      return UNKNOWN_GESTURE;
    }

    try {
      const tensor = this.calculateRelativeHandBoneAngles(tf.tensor1d(handJoints));
      const tensorReshaped = tensor.reshape([
        1,
        xb.HAND_BONE_IDX_CONNECTION_MAP.length,
        1,
      ]);

      const result = runWithTfjsTensors(this.model, tensorReshaped);
      const logits = result[0].as1D().arraySync();
      if (logits.length === 7) {
        let bestIdx = 0;
        let bestValue = logits[0];
        for (let i = 1; i < logits.length; i += 1) {
          if (logits[i] > bestValue) {
            bestIdx = i;
            bestValue = logits[i];
          }
        }
        return bestIdx;
      }
    } catch (error) {
      console.error('Rock gesture detection error.', error);
    }
    return UNKNOWN_GESTURE;
  }

  async detectHandGesture(joints) {
    if (!joints || Object.keys(joints).length !== 25) {
      return UNKNOWN_GESTURE;
    }

    const handJointPositions = [];
    for (const key in joints) {
      handJointPositions.push(joints[key].position.x);
      handJointPositions.push(joints[key].position.y);
      handJointPositions.push(joints[key].position.z);
    }

    if (handJointPositions.length !== 25 * 3) {
      return UNKNOWN_GESTURE;
    }

    const result = await this.detectGesture(handJointPositions);
    return this.shiftIndexIfNeeded(joints, result);
  }

  shiftIndexIfNeeded(joints, result) {
    result += result > 2 ? 1 : 0;
    if (result === 2) {
      const thumbDirection = this.isThumbUpOrDown(
        joints['thumb-phalanx-distal']?.position,
        joints['thumb-tip']?.position
      );
      result = thumbDirection === 0 ? 0 : thumbDirection < 0 ? result + 1 : result;
    }
    return result;
  }

  isThumbUpOrDown(p1, p2) {
    if (!p1 || !p2) return 0;
    const vector = {
      x: p2.x - p1.x,
      y: p2.y - p1.y,
      z: p2.z - p1.z,
    };
    const magnitude = Math.sqrt(
      vector.x * vector.x +
        vector.y * vector.y +
        vector.z * vector.z
    );
    if (magnitude < 0.001) {
      return 0;
    }
    const normalizedVector = {
      x: vector.x / magnitude,
      y: vector.y / magnitude,
      z: vector.z / magnitude,
    };
    const cosUpThreshold = Math.cos((45 * Math.PI) / 180);
    const dotUp = normalizedVector.y;
    const dotDown = -normalizedVector.y;
    if (dotUp >= cosUpThreshold) return 1;
    if (dotDown >= cosUpThreshold) return -1;
    return 0;
  }

  async update() {
    if (!this.enabled || this.modelState !== 'ready' || this.isProcessing) {
      return;
    }

    this.frameId += 1;
    if (this.frameId % 5 !== 0) {
      return;
    }

    const hands = xb.user.hands;
    if (!hands?.hands?.length) {
      this.wasRocking[LEFT_HAND_INDEX] = false;
      this.wasRocking[RIGHT_HAND_INDEX] = false;
      return;
    }

    this.isProcessing = true;
    try {
      for (const handIndex of [LEFT_HAND_INDEX, RIGHT_HAND_INDEX]) {
        const hand = hands.hands[handIndex];
        const joints = hand?.joints;
        const result = joints ? await this.detectHandGesture(joints) : UNKNOWN_GESTURE;
        const isRock = result === ROCK_GESTURE;
        if (isRock && !this.wasRocking[handIndex]) {
          this.onRecall({
            handIndex,
            hand: handIndex === LEFT_HAND_INDEX ? 'left' : 'right',
            joints,
          });
        }
        this.wasRocking[handIndex] = isRock;
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
