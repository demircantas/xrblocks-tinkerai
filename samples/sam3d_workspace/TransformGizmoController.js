import * as THREE from 'three';
import * as xb from 'xrblocks';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const DEFAULT_GIZMO_RADIUS = 0.14;
const MIN_GIZMO_RADIUS = 0.09;
const MAX_GIZMO_RADIUS = 0.42;
const MOVE_HANDLE_RADIUS = 0.11;
const SCALE_HANDLE_SIZE = 0.18;
const HANDLE_OPACITY = 0.94;
const ACTIVE_OPACITY = 1.0;
const MIN_SCALE = 0.01;
const MAX_SCALE = 50;
const DIRECT_GRAB_TORUS_THRESHOLD = 0.22;
const DIRECT_GRAB_SPHERE_THRESHOLD = 0.22;
const DIRECT_GRAB_BOX_THRESHOLD = 0.18;

export class TransformGizmoController {
  constructor({sceneRoot, onTransformChanged = () => {}, onStatus = () => {}} = {}) {
    this.sceneRoot = sceneRoot;
    this.onTransformChanged = onTransformChanged;
    this.onStatus = onStatus;

    this.root = new THREE.Group();
    this.root.name = 'TransformGizmoRoot';
    this.root.visible = false;
    this.root.renderOrder = 20;
    this.root.userData.isTransformGizmoRoot = true;
    this.sceneRoot.add(this.root);

    this.handles = [];
    this.target = null;
    this.enabled = false;
    this.activeInteraction = null;

    this.raycaster = new THREE.Raycaster();
    this.bounds = new THREE.Box3();
    this.boundsSize = new THREE.Vector3();
    this.boundsCenter = new THREE.Vector3();
    this.targetWorldPosition = new THREE.Vector3();
    this.targetWorldQuaternion = new THREE.Quaternion();
    this.targetWorldScale = new THREE.Vector3();
    this.parentWorldQuaternion = new THREE.Quaternion();
    this.parentWorldScale = new THREE.Vector3();
    this.parentWorldPosition = new THREE.Vector3();
    this.parentWorldMatrix = new THREE.Matrix4();
    this.parentWorldMatrixInverse = new THREE.Matrix4();
    this.controllerOrigin = new THREE.Vector3();
    this.controllerDirection = new THREE.Vector3();
    this.cameraDirection = new THREE.Vector3();
    this.plane = new THREE.Plane();
    this.currentPoint = new THREE.Vector3();
    this.startVector = new THREE.Vector3();
    this.currentVector = new THREE.Vector3();
    this.delta = new THREE.Vector3();
    this.tmpVector = new THREE.Vector3();
    this.tmpVector2 = new THREE.Vector3();
    this.tmpQuaternion = new THREE.Quaternion();
    this.tmpQuaternion2 = new THREE.Quaternion();
    this.tmpMatrix = new THREE.Matrix4();
    this.tmpScale = new THREE.Vector3();
    this.identityQuaternion = new THREE.Quaternion();
    this.pointerWorldPosition = new THREE.Vector3();

    this.buildHandles();
  }

  dispose() {
    this.stopInteraction();
    for (const handle of this.handles) {
      handle.geometry?.dispose?.();
      handle.material?.dispose?.();
    }
    this.root.removeFromParent();
  }

  setTarget(target, {enabled = true} = {}) {
    if (this.target !== target) {
      this.stopInteraction();
    }
    this.target = target || null;
    this.enabled = !!this.target && enabled;
    this.root.visible = this.enabled;
    this.update();
  }

  setEnabled(enabled) {
    this.enabled = !!this.target && enabled;
    if (!this.enabled) {
      this.stopInteraction();
    }
    this.root.visible = this.enabled;
  }

  isInteracting() {
    return !!this.activeInteraction;
  }

  onSelectStart(event) {
    if (!this.enabled || !this.target) return false;
    const hit = this.findHandleHit(event.target);
    if (!hit) return false;

    const interaction = this.beginInteraction(hit, event.target);
    if (!interaction) return false;

    this.activeInteraction = interaction;
    this.setHandleActive(interaction.handle, true);
    this.onStatus(interaction.statusStart || 'Transform interaction started.');
    return true;
  }

  onSelecting(event) {
    if (!this.activeInteraction) return false;
    if (event.target !== this.activeInteraction.controller) return true;
    this.updateInteraction(this.activeInteraction, event.target);
    return true;
  }

  onSelectEnd(event) {
    if (!this.activeInteraction) return false;
    if (event.target !== this.activeInteraction.controller) return false;
    const handle = this.activeInteraction.handle;
    this.stopInteraction();
    this.setHandleActive(handle, false);
    this.onStatus('Transform interaction finished.');
    return true;
  }

  update() {
    if (!this.enabled || !this.target) {
      this.root.visible = false;
      return;
    }

    this.root.visible = true;
    for (const mesh of this.handles) {
      mesh.ignoreReticleRaycast = !!xb.core.renderer?.xr?.isPresenting;
    }
    this.updateTargetWorldPose();
    this.updateGizmoPose();

    if (this.activeInteraction) {
      this.updateInteraction(this.activeInteraction, this.activeInteraction.controller);
    }
  }

  buildHandles() {
    const torusGeometry = new THREE.TorusGeometry(1, 0.035, 18, 96);
    const moveGeometry = new THREE.SphereGeometry(MOVE_HANDLE_RADIUS, 20, 20);
    const scaleGeometry = new THREE.BoxGeometry(
      SCALE_HANDLE_SIZE,
      SCALE_HANDLE_SIZE,
      SCALE_HANDLE_SIZE
    );

    this.createHandle({
      name: 'rotateX',
      type: 'rotate',
      axis: 'x',
      color: '#ef4444',
      geometry: torusGeometry.clone(),
      rotation: new THREE.Euler(0, Math.PI / 2, 0),
    });
    this.createHandle({
      name: 'rotateY',
      type: 'rotate',
      axis: 'y',
      color: '#22c55e',
      geometry: torusGeometry.clone(),
      rotation: new THREE.Euler(Math.PI / 2, 0, 0),
    });
    this.createHandle({
      name: 'rotateZ',
      type: 'rotate',
      axis: 'z',
      color: '#3b82f6',
      geometry: torusGeometry.clone(),
      rotation: new THREE.Euler(0, 0, 0),
    });

    this.createHandle({
      name: 'move',
      type: 'move',
      axis: null,
      color: '#f8fafc',
      geometry: moveGeometry,
      position: new THREE.Vector3(0, 0, 0),
    });

    this.createHandle({
      name: 'scale',
      type: 'scale',
      axis: null,
      color: '#e2e8f0',
      geometry: scaleGeometry,
      position: new THREE.Vector3(0, 1.35, 0),
    });
  }

  createHandle({name, type, axis, color, geometry, rotation = null, position = null}) {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: HANDLE_OPACITY,
      depthTest: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.renderOrder = 20;
    mesh.userData.isTransformGizmo = true;
    mesh.userData.transformHandle = {name, type, axis};
    if (rotation) mesh.rotation.copy(rotation);
    if (position) mesh.position.copy(position);
    this.root.add(mesh);
    this.handles.push(mesh);
    return mesh;
  }

  updateTargetWorldPose() {
    this.target.updateMatrixWorld(true);
    this.target.getWorldPosition(this.targetWorldPosition);
    this.target.getWorldQuaternion(this.targetWorldQuaternion);
    this.target.getWorldScale(this.targetWorldScale);
    if (this.target.parent) {
      this.target.parent.updateMatrixWorld(true);
      this.target.parent.matrixWorld.decompose(
        this.parentWorldPosition,
        this.parentWorldQuaternion,
        this.parentWorldScale
      );
      this.parentWorldMatrix.copy(this.target.parent.matrixWorld);
      this.parentWorldMatrixInverse.copy(this.parentWorldMatrix).invert();
    } else {
      this.parentWorldPosition.set(0, 0, 0);
      this.parentWorldQuaternion.identity();
      this.parentWorldScale.set(1, 1, 1);
      this.parentWorldMatrix.identity();
      this.parentWorldMatrixInverse.identity();
    }
  }

  updateGizmoPose() {
    const contentRoot = this.findContentRoot(this.target);
    this.bounds.makeEmpty();
    if (contentRoot) {
      this.bounds.setFromObject(contentRoot);
    }
    if (this.bounds.isEmpty()) {
      this.boundsCenter.copy(this.targetWorldPosition);
      this.boundsSize.setScalar(DEFAULT_GIZMO_RADIUS * 2);
    } else {
      this.bounds.getCenter(this.boundsCenter);
      this.bounds.getSize(this.boundsSize);
    }

    const maxDimension = Math.max(this.boundsSize.x, this.boundsSize.y, this.boundsSize.z);
    const gizmoRadius = THREE.MathUtils.clamp(maxDimension * 0.6, MIN_GIZMO_RADIUS, MAX_GIZMO_RADIUS);
    this.root.position.copy(this.targetWorldPosition);
    this.root.quaternion.copy(this.targetWorldQuaternion);
    this.root.scale.setScalar(gizmoRadius);
  }

  findContentRoot(target) {
    if (!target) return null;
    const previewModel = target.children?.find(
      (child) => child.userData?.isAssetPreviewModel
    );
    if (previewModel) {
      return previewModel.gltfMesh?.scene ||
        previewModel.children.find(
          (child) => child.type === 'Group' || child.type === 'Scene'
        ) ||
        previewModel;
    }
    return target.gltfMesh?.scene ||
      target.children.find((child) => child.type === 'Group' || child.type === 'Scene') ||
      target;
  }

  findHandleHit(controller) {
    if (xb.core.renderer?.xr?.isPresenting) {
      return this.findHandleByProximity(controller);
    }

    const intersections = xb.core.input?.intersectionsForController?.get(controller) || [];
    for (const intersection of intersections) {
      let current = intersection.object;
      while (current) {
        if (current.userData?.transformHandle) {
          return {
            intersection,
            object: current,
            handle: current.userData.transformHandle,
          };
        }
        current = current.parent;
      }
    }

    if (xb.core.renderer?.xr?.isPresenting) {
      return this.findHandleByProximity(controller);
    }

    return null;
  }

  findHandleByProximity(controller) {
    controller.updateMatrixWorld(true);
    const controllerWorld = controller.getWorldPosition(this.pointerWorldPosition).clone();
    let bestHit = null;
    let bestDistance = Infinity;

    for (const mesh of this.handles) {
      const handle = mesh.userData?.transformHandle;
      if (!handle) continue;
      const localPoint = mesh.worldToLocal(controllerWorld.clone());
      let score = Infinity;
      let hitPointLocal = null;

      if (handle.type === 'rotate') {
        const radial = Math.sqrt(localPoint.x * localPoint.x + localPoint.y * localPoint.y);
        const tubeDistance = Math.sqrt((radial - 1) * (radial - 1) + localPoint.z * localPoint.z);
        score = tubeDistance;
        if (tubeDistance <= DIRECT_GRAB_TORUS_THRESHOLD) {
          const safeRadial = radial > 1e-5 ? radial : 1;
          hitPointLocal = new THREE.Vector3(localPoint.x / safeRadial, localPoint.y / safeRadial, 0);
        }
      } else if (handle.type === 'move') {
        score = localPoint.length();
        if (score <= DIRECT_GRAB_SPHERE_THRESHOLD) {
          hitPointLocal = new THREE.Vector3(0, 0, 0);
        }
      } else if (handle.type === 'scale') {
        const dx = Math.max(Math.abs(localPoint.x) - SCALE_HANDLE_SIZE * 0.5, 0);
        const dy = Math.max(Math.abs(localPoint.y) - SCALE_HANDLE_SIZE * 0.5, 0);
        const dz = Math.max(Math.abs(localPoint.z) - SCALE_HANDLE_SIZE * 0.5, 0);
        score = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (score <= DIRECT_GRAB_BOX_THRESHOLD) {
          hitPointLocal = new THREE.Vector3(0, 0, 0);
        }
      }

      if (!hitPointLocal || score >= bestDistance) continue;
      bestDistance = score;
      bestHit = {
        intersection: {
          point: mesh.localToWorld(hitPointLocal.clone()),
          object: mesh,
        },
        object: mesh,
        handle,
      };
    }

    return bestHit;
  }

  beginInteraction(hit, controller) {
    this.updateTargetWorldPose();
    this.updateGizmoPose();

    const handle = hit.handle;
    const originalPosition = this.targetWorldPosition.clone();
    const originalQuaternion = this.targetWorldQuaternion.clone();
    const originalScale = this.target.scale.clone();

    if (handle.type === 'rotate') {
      const axisWorld = this.getHandleAxisWorld(handle.axis);
      this.plane.setFromNormalAndCoplanarPoint(axisWorld, originalPosition);
      const startVector = this.projectPointToPlane(hit.intersection.point, originalPosition, axisWorld);
      if (!startVector || startVector.lengthSq() < 1e-6) {
        return null;
      }
      return {
        mode: 'rotate',
        controller,
        handle,
        axisWorld,
        centerWorld: originalPosition,
        originalQuaternion,
        originalPosition,
        originalScale,
        startVector,
        statusStart: `Rotating ${handle.axis.toUpperCase()} axis.`,
      };
    }

    if (handle.type === 'move') {
      if (xb.core.renderer?.xr?.isPresenting) {
        const controllerWorldPosition = this.getControllerWorldPosition(controller);
        return {
          mode: 'move',
          controller,
          handle,
          originalPosition,
          originalQuaternion,
          originalScale,
          controllerStartPosition: controllerWorldPosition,
          statusStart: 'Moving active asset freely in XR.',
        };
      }

      xb.core.camera.getWorldDirection(this.cameraDirection).normalize();
      this.plane.setFromNormalAndCoplanarPoint(this.cameraDirection, originalPosition);
      const startPoint = this.intersectControllerPlane(controller, this.plane);
      if (!startPoint) {
        return null;
      }
      return {
        mode: 'move',
        controller,
        handle,
        plane: this.plane.clone(),
        originalPosition,
        originalQuaternion,
        originalScale,
        startPoint,
        statusStart: 'Moving active asset.',
      };
    }

    if (handle.type === 'scale') {
      if (xb.core.renderer?.xr?.isPresenting) {
        const controllerWorldPosition = this.getControllerWorldPosition(controller);
        const startDistance = controllerWorldPosition.distanceTo(originalPosition);
        return {
          mode: 'scale',
          controller,
          handle,
          originalPosition,
          originalQuaternion,
          originalScale,
          startDistance: Math.max(startDistance, 1e-4),
          statusStart: 'Scaling active asset uniformly.',
        };
      }

      xb.core.camera.getWorldDirection(this.cameraDirection).normalize();
      this.plane.setFromNormalAndCoplanarPoint(this.cameraDirection, originalPosition);
      const startPoint = this.intersectControllerPlane(controller, this.plane);
      if (!startPoint) {
        return null;
      }
      const startDistance = startPoint.distanceTo(originalPosition);
      return {
        mode: 'scale',
        controller,
        handle,
        plane: this.plane.clone(),
        originalPosition,
        originalQuaternion,
        originalScale,
        startPoint,
        startDistance: Math.max(startDistance, 1e-4),
        statusStart: 'Scaling active asset uniformly.',
      };
    }

    return null;
  }

  updateInteraction(interaction, controller) {
    if (!this.target) return;

    if (interaction.mode === 'rotate') {
      const point = this.getRotationInteractionPoint(controller, this.plane);
      if (!point) return;
      const currentVector = this.projectPointToPlane(point, interaction.centerWorld, interaction.axisWorld);
      if (!currentVector || currentVector.lengthSq() < 1e-6) return;
      const angle = this.computeSignedAngle(interaction.startVector, currentVector, interaction.axisWorld);
      const deltaQuat = this.tmpQuaternion.setFromAxisAngle(interaction.axisWorld, angle);
      const nextWorldQuaternion = this.tmpQuaternion2.copy(deltaQuat).multiply(interaction.originalQuaternion);
      this.setTargetWorldQuaternion(nextWorldQuaternion);
    } else if (interaction.mode === 'move') {
      if (xb.core.renderer?.xr?.isPresenting && interaction.controllerStartPosition) {
        const controllerPosition = this.getControllerWorldPosition(controller);
        const delta = this.delta.copy(controllerPosition).sub(interaction.controllerStartPosition);
        const nextWorldPosition = this.tmpVector.copy(interaction.originalPosition).add(delta);
        this.setTargetWorldPosition(nextWorldPosition);
      } else {
        const point = this.intersectControllerPlane(controller, interaction.plane);
        if (!point) return;
        const delta = this.delta.copy(point).sub(interaction.startPoint);
        const nextWorldPosition = this.tmpVector.copy(interaction.originalPosition).add(delta);
        this.setTargetWorldPosition(nextWorldPosition);
      }
    } else if (interaction.mode === 'scale') {
      let distance = 0;
      if (xb.core.renderer?.xr?.isPresenting) {
        const controllerPosition = this.getControllerWorldPosition(controller);
        distance = Math.max(controllerPosition.distanceTo(interaction.originalPosition), 1e-4);
      } else {
        const point = this.intersectControllerPlane(controller, interaction.plane);
        if (!point) return;
        distance = Math.max(point.distanceTo(interaction.originalPosition), 1e-4);
      }
      const factor = THREE.MathUtils.clamp(distance / interaction.startDistance, MIN_SCALE, MAX_SCALE);
      this.target.scale.copy(interaction.originalScale).multiplyScalar(factor);
      this.target.updateMatrix();
      this.target.updateMatrixWorld(true);
    }

    this.onTransformChanged(this.target);
    this.updateTargetWorldPose();
    this.updateGizmoPose();
  }

  stopInteraction() {
    if (this.activeInteraction?.handle) {
      this.setHandleActive(this.activeInteraction.handle, false);
    }
    this.activeInteraction = null;
  }

  setHandleActive(handle, isActive) {
    for (const mesh of this.handles) {
      const meshHandle = mesh.userData?.transformHandle;
      if (!meshHandle) continue;
      const matches = meshHandle.name === handle?.name;
      mesh.material.opacity = matches && isActive ? ACTIVE_OPACITY : HANDLE_OPACITY;
      mesh.scale.setScalar(matches && isActive ? 1.1 : 1.0);
    }
  }

  getHandleAxisWorld(axis) {
    const localAxis = axis === 'x' ? X_AXIS : axis === 'y' ? Y_AXIS : Z_AXIS;
    return this.tmpVector.copy(localAxis).applyQuaternion(this.targetWorldQuaternion).normalize().clone();
  }

  projectPointToPlane(point, center, axisNormal) {
    const projected = this.tmpVector2.copy(point).sub(center);
    const normalComponent = axisNormal.dot(projected);
    projected.addScaledVector(axisNormal, -normalComponent);
    if (projected.lengthSq() < 1e-8) {
      return null;
    }
    return projected.normalize().clone();
  }

  computeSignedAngle(from, to, axisNormal) {
    const cross = this.tmpVector.copy(from).cross(to);
    const dot = THREE.MathUtils.clamp(from.dot(to), -1, 1);
    const angle = Math.atan2(cross.dot(axisNormal), dot);
    return angle;
  }

  getControllerWorldPosition(controller) {
    controller.updateMatrixWorld(true);
    return controller.getWorldPosition(this.pointerWorldPosition).clone();
  }

  getRotationInteractionPoint(controller, plane) {
    if (xb.core.renderer?.xr?.isPresenting) {
      return this.getControllerWorldPosition(controller);
    }
    return this.intersectControllerPlane(controller, plane);
  }

  intersectControllerPlane(controller, plane) {
    controller.updateMatrixWorld(true);
    controller.getWorldPosition(this.controllerOrigin);
    this.tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this.controllerDirection.set(0, 0, -1).applyMatrix4(this.tmpMatrix).normalize();
    this.raycaster.ray.origin.copy(this.controllerOrigin);
    this.raycaster.ray.direction.copy(this.controllerDirection);
    const result = this.raycaster.ray.intersectPlane(plane, this.currentPoint);
    return result ? this.currentPoint.clone() : null;
  }

  setTargetWorldPosition(worldPosition) {
    if (!this.target) return;
    if (this.target.parent) {
      const localPosition = this.tmpVector.copy(worldPosition);
      this.target.parent.worldToLocal(localPosition);
      this.target.position.copy(localPosition);
    } else {
      this.target.position.copy(worldPosition);
    }
    this.target.updateMatrix();
    this.target.updateMatrixWorld(true);
  }

  setTargetWorldQuaternion(worldQuaternion) {
    if (!this.target) return;
    const localQuaternion = this.tmpQuaternion.copy(this.parentWorldQuaternion).invert().multiply(worldQuaternion);
    this.target.quaternion.copy(localQuaternion);
    this.target.updateMatrix();
    this.target.updateMatrixWorld(true);
  }
}
