import * as THREE from 'three';
import * as xb from 'xrblocks';
import {MarchingCubes} from 'three/addons/objects/MarchingCubes.js';

const DEFAULT_PROXIMITY = 0.03;
const DEFAULT_SELECTION_BRUSH_RADIUS = 0.08;
const DEFAULT_VISUAL_BRUSH_RADIUS = 0.08;
const DEFAULT_STAMP_INTERVAL_MS = 70;
const DEFAULT_SAMPLE_STEP_DISTANCE = 0.015;
const MIN_BRUSH_RADIUS = 0.02;
const MAX_BRUSH_RADIUS = 0.3;
const IDLE_BRUSH_OPACITY = 0.16;
const ACTIVE_BRUSH_OPACITY = 0.45;
const STATUS_INTERVAL_MS = 120;
const SCULPT_RESOLUTION = 28;
const SCULPT_SUBTRACT = 12;
const SCULPT_MAX_POLYGONS = 12000;
const USE_DEBUG_SPHERE_BRUSH = true;
const DEBUG_SPHERE_INITIAL_CAPACITY = 64;
const DEBUG_SPHERE_WIDTH_SEGMENTS = 8;
const DEBUG_SPHERE_HEIGHT_SEGMENTS = 6;

const IDENTITY_QUATERNION = new THREE.Quaternion();
const NO_RAYCAST = () => {};

export class MeshSelectionController {
  constructor({
    sceneRoot,
    onSelectionChanged = () => {},
    onStatus = () => {},
  }) {
    this.sceneRoot = sceneRoot;
    this.onSelectionChanged = onSelectionChanged;
    this.onStatus = onStatus;

    this.overlay = new THREE.Group();
    this.overlay.ignoreReticleRaycast = true;
    this.sceneRoot.add(this.overlay);

    this.raycaster = new THREE.Raycaster();
    this.selectionBrushRadius = DEFAULT_SELECTION_BRUSH_RADIUS;
    this.visualBrushRadius = DEFAULT_VISUAL_BRUSH_RADIUS;
    this.proximity = DEFAULT_PROXIMITY;
    this.paintMode = 'discard';
    this.stampIntervalMs = DEFAULT_STAMP_INTERVAL_MS;
    this.sampleStepDistance = DEFAULT_SAMPLE_STEP_DISTANCE;

    this.activeAssetId = null;
    this.activeModel = null;
    this.contentRoot = null;
    this.meshes = [];
    this.meshMetaByNodePath = new Map();
    this.meshByNodePath = new Map();
    this.isDrawMode = false;
    this.isPinching = false;
    this.activePinchSource = null;
    this.previewVisible = false;
    this.selectionDirty = false;
    this.implicitKeepAll = true;
    this.totalVertexCount = 0;
    this.selectedVertexCount = 0;
    this.strokeWorldPoints = [];
    this.visualStrokePoints = [];
    this.sculptMesh = null;
    this.sculptSphereGeometry = null;
    this.sculptSphereMaterial = null;
    this.sculptSphereCapacity = 0;
    this.sculptBounds = new THREE.Box3();
    this.sculptBoundsMin = new THREE.Vector3();
    this.sculptBoundsCenter = new THREE.Vector3();
    this.sculptBoundsSize = 1;
    this.lastStampTimeMs = 0;
    this.lastStatusTimeMs = 0;

    this._tmpRotation = new THREE.Matrix4();
    this._tmpScale = new THREE.Vector3();
    this._tmpWorldPoint = new THREE.Vector3();
    this._tmpLocalPoint = new THREE.Vector3();
    this._tmpRayDirection = new THREE.Vector3();
    this._tmpRayOrigin = new THREE.Vector3();
    this._tmpInterpPoint = new THREE.Vector3();
    this._tmpBoxSize = new THREE.Vector3();
    this._tmpBoxCenter = new THREE.Vector3();
    this._tmpSphereScale = new THREE.Vector3();
    this._tmpInstanceMatrix = new THREE.Matrix4();
  }

  dispose() {
    this.detach();
    this.sceneRoot?.remove(this.overlay);
    this.disposeDebugSphereResources();
  }

  attach({assetId, model, selections = []}) {
    this.detach();

    this.activeAssetId = assetId;
    this.activeModel = model;
    this.contentRoot = this.findContentRoot(model);
    this.buildMeshIndex();
    this.updateSculptBounds();
    this.applySelections(selections);
    this.applyModelInteractionPolicy();
  }

  detach() {
    this.setDrawMode(false);
    this.clearSelectionPreview();
    this.clearSculptMesh();
    this.applyModelInteractionPolicy(true);

    this.activeAssetId = null;
    this.activeModel = null;
    this.contentRoot = null;
    this.meshes = [];
    this.meshMetaByNodePath.clear();
    this.meshByNodePath.clear();
    this.isPinching = false;
    this.activePinchSource = null;
    this.previewVisible = false;
    this.selectionDirty = false;
    this.implicitKeepAll = true;
    this.totalVertexCount = 0;
    this.selectedVertexCount = 0;
    this.strokeWorldPoints = [];
    this.visualStrokePoints = [];
  }

  findContentRoot(model) {
    if (!model) return null;
    return (
      model.children.find((child) => child.type === 'Group' || child.type === 'Scene') ||
      model
    );
  }

  buildMeshIndex() {
    this.meshes = [];
    this.meshMetaByNodePath.clear();
    this.meshByNodePath.clear();
    this.totalVertexCount = 0;

    if (!this.contentRoot) return;

    const counters = new Map();
    this.contentRoot.traverse((node) => {
      if (!node.isMesh || !node.geometry?.attributes?.position) return;
      const positionAttr = node.geometry.attributes.position;
      const vertexCount = positionAttr.count;
      if (vertexCount <= 0) return;

      const nodePath = this.createNodePath(node, counters);
      const selectionMask = new Array(vertexCount).fill(false);
      const meta = {
        mesh: node,
        nodePath,
        positionAttr,
        vertexCount,
        selectionMask,
        selectedCount: 0,
      };

      this.meshes.push(node);
      this.meshMetaByNodePath.set(nodePath, meta);
      this.meshByNodePath.set(nodePath, node);
      node.userData.selectionNodePath = nodePath;
      this.totalVertexCount += vertexCount;
    });
    this.selectedVertexCount = this.totalVertexCount;
  }

  createNodePath(node, counters) {
    const pathParts = [];
    let current = node;
    while (current && current !== this.contentRoot) {
      const baseName = current.name?.trim() || current.type || 'node';
      const key = `${current.parent?.uuid || 'root'}:${baseName}`;
      const seen = counters.get(key) || 0;
      counters.set(key, seen + 1);
      pathParts.push(`${baseName}_${seen}`);
      current = current.parent;
    }
    return `/${pathParts.reverse().join('/')}`;
  }

  updateSculptBounds() {
    if (!this.contentRoot) {
      this.sculptBounds.makeEmpty();
      return;
    }

    this.sculptBounds.setFromObject(this.contentRoot);
    if (this.sculptBounds.isEmpty()) {
      return;
    }

    this.sculptBounds.getSize(this._tmpBoxSize);
    this.sculptBounds.getCenter(this._tmpBoxCenter);
    const cubeSize = Math.max(this._tmpBoxSize.x, this._tmpBoxSize.y, this._tmpBoxSize.z) +
      this.visualBrushRadius * 4;
    this.sculptBoundsCenter.copy(this._tmpBoxCenter);
    this.sculptBoundsMin.copy(this.sculptBoundsCenter).addScalar(-cubeSize / 2);
    this.sculptBoundsSize = Math.max(cubeSize, 0.001);
  }

  setDrawMode(enabled) {
    this.isDrawMode = enabled && !!this.activeModel && this.meshes.length > 0;
    if (this.isDrawMode) {
      this.ensureSculptMesh();
    } else {
      this.isPinching = false;
      this.activePinchSource = null;
      this.strokeWorldPoints = [];
      this.clearSculptMesh();
    }
    this.applyModelInteractionPolicy();
  }

  getDrawMode() {
    return this.isDrawMode;
  }

  hasTarget() {
    return !!this.activeModel && this.meshes.length > 0;
  }

  getSelectionCount() {
    return this.selectedVertexCount;
  }

  getPaintMode() {
    return this.paintMode;
  }

  setPaintMode(mode) {
    this.paintMode = mode === 'keep' ? 'keep' : 'discard';
    this.updateSculptMaterial();
  }

  getBrushRadius() {
    return this.selectionBrushRadius;
  }

  setBrushRadius(radius) {
    const nextRadius = THREE.MathUtils.clamp(radius, MIN_BRUSH_RADIUS, MAX_BRUSH_RADIUS);
    this.selectionBrushRadius = nextRadius;
    this.visualBrushRadius = nextRadius;
    if (this.activeModel) {
      this.updateSculptBounds();
    }
    if (this.sculptMesh && USE_DEBUG_SPHERE_BRUSH) {
      this.refreshDebugSphereInstances();
    } else if (this.sculptMesh) {
      this.rebuildSculptMesh();
    }
    return nextRadius;
  }

  clearSelection() {
    for (const meta of this.meshMetaByNodePath.values()) {
      meta.selectionMask.fill(false);
      meta.selectedCount = 0;
    }
    this.implicitKeepAll = true;
    this.selectedVertexCount = this.totalVertexCount;
    this.clearSelectionPreview();
    this.clearSculptMesh();
    this.previewVisible = false;
    this.selectionDirty = false;
    this.emitSelectionChanged();
  }

  applySelections(selections = []) {
    for (const meta of this.meshMetaByNodePath.values()) {
      meta.selectionMask.fill(false);
      meta.selectedCount = 0;
    }

    if (!selections.length) {
      this.implicitKeepAll = true;
      this.selectedVertexCount = this.totalVertexCount;
      this.emitSelectionChanged();
      return;
    }

    this.implicitKeepAll = false;
    for (const selection of selections) {
      const meta = this.meshMetaByNodePath.get(selection.nodePath);
      if (!meta) continue;
      for (const index of selection.vertexIndices || []) {
        if (index < 0 || index >= meta.vertexCount) continue;
        if (!meta.selectionMask[index]) {
          meta.selectionMask[index] = true;
          meta.selectedCount += 1;
        }
      }
    }

    this.selectedVertexCount = [...this.meshMetaByNodePath.values()].reduce(
      (sum, meta) => sum + meta.selectedCount,
      0
    );
    if (this.selectedVertexCount >= this.totalVertexCount) {
      this.implicitKeepAll = true;
    }
    this.emitSelectionChanged();
  }

  ensureExplicitKeepMask() {
    if (!this.implicitKeepAll) {
      return;
    }
    for (const meta of this.meshMetaByNodePath.values()) {
      meta.selectionMask.fill(true);
      meta.selectedCount = meta.vertexCount;
    }
    this.implicitKeepAll = false;
    this.selectedVertexCount = this.totalVertexCount;
  }

  exportSelections() {
    if (this.implicitKeepAll || this.selectedVertexCount >= this.totalVertexCount) {
      return [];
    }

    const selections = [];
    for (const meta of this.meshMetaByNodePath.values()) {
      if (!meta.selectedCount) continue;
      const vertexIndices = [];
      for (let i = 0; i < meta.selectionMask.length; i++) {
        if (meta.selectionMask[i]) {
          vertexIndices.push(i);
        }
      }
      selections.push({
        nodePath: meta.nodePath,
        vertexIndices,
        proximity: this.proximity,
      });
    }
    return selections;
  }

  emitSelectionChanged() {
    this.onSelectionChanged({
      assetId: this.activeAssetId,
      selections: this.exportSelections(),
      selectedVertexCount: this.selectedVertexCount,
    });
  }

  applyModelInteractionPolicy(_forceEnable = false) {
    if (!this.activeModel) return;
    this.activeModel.draggable = false;
    this.activeModel.rotatable = false;
    this.activeModel.scalable = false;

    this.activeModel.traverse((node) => {
      if (node === this.overlay || node.userData?.isSelectionPreview) return;
      node.ignoreReticleRaycast = true;
    });
  }

  disableReticleRaycast(target) {
    if (!target) return target;
    target.ignoreReticleRaycast = true;
    target.raycast = NO_RAYCAST;
    return target;
  }

  getVisualPointSpacing() {
    return Math.max(this.visualBrushRadius * 0.45, this.sampleStepDistance * 1.5);
  }

  appendVisualStrokePoint(point) {
    const spacing = this.getVisualPointSpacing();
    const lastPoint = this.visualStrokePoints[this.visualStrokePoints.length - 1];
    if (lastPoint && lastPoint.distanceToSquared(point) < spacing * spacing) {
      return;
    }

    const visualPoint = point.clone();
    this.visualStrokePoints.push(visualPoint);
    if (USE_DEBUG_SPHERE_BRUSH) {
      this.appendDebugSphereInstance(visualPoint);
    }
  }

  clearSelectionPreview() {
    for (const mesh of this.meshes) {
      const children = [...mesh.children];
      for (const child of children) {
        if (!child.userData?.isSelectionPreview) continue;
        mesh.remove(child);
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      }
    }
  }

  renderSelectionPreview() {
    this.clearSelectionPreview();

    let totalPreviewed = 0;
    for (const meta of this.meshMetaByNodePath.values()) {
      const showAll = this.implicitKeepAll;
      if (!showAll && !meta.selectedCount) continue;
      const selectedLocal = [];
      const pos = meta.positionAttr.array;
      const stride = meta.positionAttr.itemSize || 3;
      for (let i = 0; i < meta.vertexCount; i++) {
        if (!showAll && !meta.selectionMask[i]) continue;
        const base = i * stride;
        selectedLocal.push(pos[base], pos[base + 1], pos[base + 2]);
      }
      if (!selectedLocal.length) continue;

      const previewGeom = new THREE.BufferGeometry();
      previewGeom.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(selectedLocal, 3)
      );
      const previewMat = new THREE.PointsMaterial({
        color: 0x22c55e,
        size: 0.01,
        sizeAttenuation: true,
        depthWrite: false,
      });
      const previewPoints = new THREE.Points(previewGeom, previewMat);
      previewPoints.userData.isSelectionPreview = true;
      this.disableReticleRaycast(previewPoints);
      meta.mesh.add(previewPoints);
      totalPreviewed += selectedLocal.length / 3;
    }

    this.previewVisible = totalPreviewed > 0;
    return totalPreviewed;
  }

  ensureSculptMesh() {
    if (this.sculptMesh || !this.hasTarget()) {
      return;
    }

    if (USE_DEBUG_SPHERE_BRUSH) {
      this.ensureDebugSphereResources();
      this.sculptSphereCapacity = Math.max(
        this.sculptSphereCapacity || 0,
        DEBUG_SPHERE_INITIAL_CAPACITY
      );
      this.sculptMesh = this.createDebugSphereMesh(this.sculptSphereCapacity);
      this.disableReticleRaycast(this.sculptMesh);
      this.overlay.add(this.sculptMesh);
      return;
    }

    const material = new THREE.MeshStandardMaterial({
      color: this.paintMode === 'keep' ? 0x22c55e : 0xef4444,
      transparent: true,
      opacity: 0.58,
      roughness: 0.35,
      metalness: 0.05,
      depthWrite: false,
    });
    this.sculptMesh = new MarchingCubes(
      SCULPT_RESOLUTION,
      material,
      false,
      false,
      SCULPT_MAX_POLYGONS
    );
    this.sculptMesh.isolation = 40;
    this.sculptMesh.position.copy(this.sculptBoundsCenter);
    this.sculptMesh.scale.setScalar(this.sculptBoundsSize / 2);
    this.overlay.add(this.sculptMesh);
  }

  updateSculptMaterial() {
    if (!this.sculptMesh) {
      return;
    }
    if (USE_DEBUG_SPHERE_BRUSH) {
      this.sculptSphereMaterial?.color?.set(
        this.paintMode === 'keep' ? 0x22c55e : 0xef4444
      );
      return;
    }
    this.sculptMesh.material.color.set(
      this.paintMode === 'keep' ? 0x22c55e : 0xef4444
    );
  }

  ensureDebugSphereResources() {
    if (!USE_DEBUG_SPHERE_BRUSH) {
      return;
    }

    if (!this.sculptSphereGeometry) {
      this.sculptSphereGeometry = new THREE.SphereGeometry(
        1,
        DEBUG_SPHERE_WIDTH_SEGMENTS,
        DEBUG_SPHERE_HEIGHT_SEGMENTS
      );
    }

    if (!this.sculptSphereMaterial) {
      this.sculptSphereMaterial = new THREE.MeshBasicMaterial({
        color: this.paintMode === 'keep' ? 0x22c55e : 0xef4444,
        transparent: true,
        opacity: ACTIVE_BRUSH_OPACITY,
        depthWrite: false,
      });
    }
  }

  createDebugSphereMesh(capacity) {
    const mesh = new THREE.InstancedMesh(
      this.sculptSphereGeometry,
      this.sculptSphereMaterial,
      capacity
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    return mesh;
  }

  ensureDebugSphereCapacity(requiredCount) {
    if (!USE_DEBUG_SPHERE_BRUSH) {
      return;
    }

    this.ensureDebugSphereResources();
    if (!this.sculptMesh) {
      return;
    }

    if (requiredCount <= this.sculptSphereCapacity) {
      return;
    }

    const nextCapacity = Math.max(
      requiredCount,
      Math.max(this.sculptSphereCapacity * 2, DEBUG_SPHERE_INITIAL_CAPACITY)
    );
    const nextMesh = this.createDebugSphereMesh(nextCapacity);
    this.overlay.remove(this.sculptMesh);
    this.sculptMesh = nextMesh;
    this.disableReticleRaycast(this.sculptMesh);
    this.sculptSphereCapacity = nextCapacity;
    this.overlay.add(this.sculptMesh);
    this.refreshDebugSphereInstances();
  }

  refreshDebugSphereInstances() {
    if (!USE_DEBUG_SPHERE_BRUSH || !this.sculptMesh) {
      return;
    }

    this.ensureDebugSphereCapacity(this.visualStrokePoints.length);
    const radius = Math.max(this.visualBrushRadius, 0.01);
    this._tmpSphereScale.setScalar(radius);

    let count = 0;
    for (const point of this.visualStrokePoints) {
      this._tmpInstanceMatrix.compose(
        point,
        IDENTITY_QUATERNION,
        this._tmpSphereScale
      );
      this.sculptMesh.setMatrixAt(count, this._tmpInstanceMatrix);
      count += 1;
    }

    this.sculptMesh.count = count;
    this.sculptMesh.instanceMatrix.needsUpdate = true;
  }

  appendDebugSphereInstance(point) {
    if (!USE_DEBUG_SPHERE_BRUSH) {
      return;
    }

    if (!this.sculptMesh) {
      this.ensureSculptMesh();
    }
    if (!this.sculptMesh) {
      return;
    }

    const nextCount = this.visualStrokePoints.length;
    this.ensureDebugSphereCapacity(nextCount);

    const radius = Math.max(this.visualBrushRadius, 0.01);
    this._tmpSphereScale.setScalar(radius);
    this._tmpInstanceMatrix.compose(
      point,
      IDENTITY_QUATERNION,
      this._tmpSphereScale
    );
    this.sculptMesh.setMatrixAt(nextCount - 1, this._tmpInstanceMatrix);
    this.sculptMesh.count = nextCount;
    this.sculptMesh.instanceMatrix.needsUpdate = true;
  }

  disposeDebugSphereResources() {
    this.sculptSphereGeometry?.dispose?.();
    this.sculptSphereMaterial?.dispose?.();
    this.sculptSphereGeometry = null;
    this.sculptSphereMaterial = null;
    this.sculptSphereCapacity = 0;
  }

  clearSculptMesh() {
    this.strokeWorldPoints = [];
    this.visualStrokePoints = [];
    if (!this.sculptMesh) {
      return;
    }
    this.overlay.remove(this.sculptMesh);
    if (USE_DEBUG_SPHERE_BRUSH) {
      this.sculptMesh.count = 0;
    } else {
      this.sculptMesh.material?.dispose?.();
      this.sculptMesh.geometry?.dispose?.();
    }
    this.sculptMesh = null;
  }

  rebuildSculptMesh() {
    if (!this.sculptMesh || !this.strokeWorldPoints.length) {
      return;
    }

    if (USE_DEBUG_SPHERE_BRUSH) {
      this.refreshDebugSphereInstances();
      return;
    }

    this.sculptMesh.reset();
    const normalizedRadius = Math.min(
      Math.max(this.visualBrushRadius / this.sculptBoundsSize, 0.02),
      0.28
    );
    const strength = SCULPT_SUBTRACT * normalizedRadius * normalizedRadius;
    for (const point of this.strokeWorldPoints) {
      const x = THREE.MathUtils.clamp(
        0.5 + (point.x - this.sculptBoundsCenter.x) / this.sculptBoundsSize,
        0.02,
        0.98
      );
      const y = THREE.MathUtils.clamp(
        0.5 + (point.y - this.sculptBoundsCenter.y) / this.sculptBoundsSize,
        0.02,
        0.98
      );
      const z = THREE.MathUtils.clamp(
        0.5 + (point.z - this.sculptBoundsCenter.z) / this.sculptBoundsSize,
        0.02,
        0.98
      );
      this.sculptMesh.addBall(x, y, z, strength, SCULPT_SUBTRACT);
    }
    this.sculptMesh.update();
  }

  appendStrokePoint(worldPoint) {
    if (!this.strokeWorldPoints.length) {
      const point = worldPoint.clone();
      this.strokeWorldPoints.push(point);
      if (USE_DEBUG_SPHERE_BRUSH) {
        this.appendVisualStrokePoint(point);
      } else {
        this.rebuildSculptMesh();
      }
      return;
    }

    const lastPoint = this.strokeWorldPoints[this.strokeWorldPoints.length - 1];
    const distance = lastPoint.distanceTo(worldPoint);
    if (distance < 0.002) return;

    const steps = Math.max(1, Math.ceil(distance / this.sampleStepDistance));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._tmpInterpPoint.copy(lastPoint).lerp(worldPoint, t);
      const point = this._tmpInterpPoint.clone();
      this.strokeWorldPoints.push(point);
      if (USE_DEBUG_SPHERE_BRUSH) {
        this.appendVisualStrokePoint(point);
      }
    }
    if (!USE_DEBUG_SPHERE_BRUSH) {
      this.rebuildSculptMesh();
    }
  }

  applyStrokeToSelection() {
    if (!this.strokeWorldPoints.length) {
      return false;
    }

    if (this.paintMode === 'discard') {
      this.ensureExplicitKeepMask();
    }

    let changed = 0;
    for (const meta of this.meshMetaByNodePath.values()) {
      const mesh = meta.mesh;
      mesh.getWorldScale(this._tmpScale);
      const avgScale =
        (this._tmpScale.x + this._tmpScale.y + this._tmpScale.z) / 3;
      const localRadius = this.selectionBrushRadius / Math.max(avgScale, 1e-6);
      const radiusSq = localRadius * localRadius;
      const pos = meta.positionAttr.array;
      const stride = meta.positionAttr.itemSize || 3;

      const localStrokePoints = this.strokeWorldPoints.map((point) =>
        mesh.worldToLocal(point.clone())
      );

      for (let i = 0; i < meta.vertexCount; i++) {
        const base = i * stride;
        const vx = pos[base];
        const vy = pos[base + 1];
        const vz = pos[base + 2];

        let touched = false;
        for (const strokePoint of localStrokePoints) {
          const dx = vx - strokePoint.x;
          const dy = vy - strokePoint.y;
          const dz = vz - strokePoint.z;
          if (dx * dx + dy * dy + dz * dz <= radiusSq) {
            touched = true;
            break;
          }
        }
        if (!touched) continue;

        if (this.paintMode === 'keep') {
          if (!this.implicitKeepAll && !meta.selectionMask[i]) {
            meta.selectionMask[i] = true;
            meta.selectedCount += 1;
            changed += 1;
          }
        } else if (meta.selectionMask[i]) {
          meta.selectionMask[i] = false;
          meta.selectedCount -= 1;
          changed += 1;
        }
      }
    }

    this.selectedVertexCount = this.implicitKeepAll
      ? this.totalVertexCount
      : [...this.meshMetaByNodePath.values()].reduce(
          (sum, meta) => sum + meta.selectedCount,
          0
        );

    if (!this.implicitKeepAll && this.selectedVertexCount >= this.totalVertexCount) {
      this.implicitKeepAll = true;
      for (const meta of this.meshMetaByNodePath.values()) {
        meta.selectionMask.fill(false);
        meta.selectedCount = 0;
      }
    }

    return changed > 0;
  }

  resolveWorldPointFromSource(source) {
    if (!source || !this.meshes.length) return null;
    if (xb.core.renderer?.xr?.isPresenting) {
      return source.getWorldPosition(this._tmpWorldPoint).clone();
    }

    this._tmpRotation.identity().extractRotation(source.matrixWorld);
    this._tmpRayDirection.set(0, 0, -1).applyMatrix4(this._tmpRotation).normalize();
    source.getWorldPosition(this._tmpRayOrigin);
    this.raycaster.ray.origin.copy(this._tmpRayOrigin);
    this.raycaster.ray.direction.copy(this._tmpRayDirection);

    const intersections = this.raycaster.intersectObjects(this.meshes, false);
    if (!intersections.length) return null;
    return intersections[0].point.clone();
  }

  getIdlePreviewSources() {
    if (this.idlePreviewSource) {
      return [this.idlePreviewSource];
    }
    if (xb.core.renderer?.xr?.isPresenting) {
      return (xb.core?.input?.controllers || []).filter(
        (controller) => controller?.userData?.id === 0 || controller?.userData?.id === 1
      );
    }
    return xb.core?.input?.mouseController ? [xb.core.input.mouseController] : [];
  }

  setBrushVisualIdle(isIdle) {
    if (USE_DEBUG_SPHERE_BRUSH) {
      if (this.sculptSphereMaterial) {
        this.sculptSphereMaterial.opacity = isIdle ? IDLE_BRUSH_OPACITY : ACTIVE_BRUSH_OPACITY;
      }
      return;
    }
    if (this.sculptMesh?.material) {
      this.sculptMesh.material.opacity = isIdle ? 0.22 : 0.58;
    }
  }

  updateIdlePreview() {
    if (!this.isDrawMode || this.isPinching || !this.meshes.length) return;
    const points = this.getIdlePreviewSources()
      .map((source) => this.resolveWorldPointFromSource(source))
      .filter(Boolean);
    if (!points.length) return;

    this.ensureSculptMesh();
    this.visualStrokePoints = points;
    this.strokeWorldPoints = [];
    this.setBrushVisualIdle(true);
    if (USE_DEBUG_SPHERE_BRUSH) {
      this.refreshDebugSphereInstances();
    } else {
      this.rebuildSculptMesh();
    }
  }

  sampleDrawFromSource(source, force = false) {
    if (!source || !this.isDrawMode || !this.meshes.length) return;
    const now = performance.now();
    if (!force && now - this.lastStampTimeMs < this.stampIntervalMs) return;
    const worldPoint = this.resolveWorldPointFromSource(source);
    if (!worldPoint) return;

    this.setBrushVisualIdle(false);
    this.appendStrokePoint(worldPoint);

    if (now - this.lastStatusTimeMs >= STATUS_INTERVAL_MS) {
      this.onStatus(
        `Discarding with sculpt brush on asset.`
      );
      this.lastStatusTimeMs = now;
    }
    this.lastStampTimeMs = now;
  }

  onSelectStart(event) {
    if (!this.isDrawMode) return;
    this.isPinching = true;
    this.activePinchSource = event.target;
    this.strokeWorldPoints = [];
    this.visualStrokePoints = [];
    this.ensureSculptMesh();
    this.sampleDrawFromSource(event.target, true);
  }

  onSelecting(event) {
    if (!this.isDrawMode || !this.isPinching) return;
    const source = event.target || this.activePinchSource;
    this.activePinchSource = source;
    this.sampleDrawFromSource(source);
  }

  onSelectEnd(event) {
    if (!this.isDrawMode) return;
    if (!this.activePinchSource || event.target === this.activePinchSource) {
      this.isPinching = false;
      this.activePinchSource = null;

      const didChange = this.applyStrokeToSelection();
      this.clearSculptMesh();
      this.renderSelectionPreview();

      if (didChange) {
        this.selectionDirty = false;
        this.emitSelectionChanged();
      }

      this.onStatus(
        this.paintMode === 'keep'
          ? `Keep stroke applied. ${this.selectedVertexCount} vertices currently kept.`
          : `Discard stroke applied. ${this.selectedVertexCount} vertices currently kept.`
      );
    }
  }

  update() {
    if (!this.isDrawMode) return;
    if (this.isPinching && this.activePinchSource) {
      this.sampleDrawFromSource(this.activePinchSource);
      return;
    }
    this.updateIdlePreview();
  }
}







