import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const COLORS = { left: 0x6dd9ee, right: 0xb5a1ff, inferred: 0xefbf77 };

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x101a27, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '左右手柄的三维姿态、坐标轴与速度箭头');
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x101a27, 0.15);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 60);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.09;
  controls.minDistance = 0.25; controls.maxDistance = 10;
  controls.maxPolarAngle = Math.PI * 0.88;
  scene.add(new THREE.HemisphereLight(0xd4e6ff, 0x202935, 2.5));
  const key = new THREE.DirectionalLight(0xe9f4ff, 4); key.position.set(2, 4, 3); scene.add(key);
  const rim = new THREE.DirectionalLight(0x708cdb, 2); rim.position.set(-3, 1, -2); scene.add(rim);
  const grid = new THREE.GridHelper(6, 24, 0x52687d, 0x35495c);
  grid.material.transparent = true; grid.material.opacity = 0.30; scene.add(grid);
  const originAxes = new THREE.AxesHelper(0.3); originAxes.material.transparent = true; originAxes.material.opacity = 0.7; scene.add(originAxes);
  const origin = new THREE.Mesh(new THREE.SphereGeometry(0.013, 16, 12), new THREE.MeshBasicMaterial({ color: 0xc7d8e7 })); scene.add(origin);
  const originRing = new THREE.Mesh(new THREE.RingGeometry(0.055, 0.058, 40), new THREE.MeshBasicMaterial({ color: 0x7692ac, side: THREE.DoubleSide, transparent: true, opacity: 0.55 }));
  originRing.rotation.x = -Math.PI / 2; originRing.position.y = 0.002; scene.add(originRing);

  function buildController(side) {
    const root = new THREE.Group(); root.visible = false; scene.add(root);
    const accent = COLORS[side], meshMaterials = [];
    const material = (color, metalness = 0.2) => {
      const value = new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.48 });
      value.userData.originalColor = color; meshMaterials.push(value); return value;
    };
    const bodyMat = material(0x263747, 0.48), topMat = material(0x3c5165, 0.4), accentMat = material(accent, 0.25);
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.024, 0.095, 8, 20), bodyMat);
    grip.position.set(0, -0.032, 0.008); grip.rotation.x = -0.13; root.add(grip);
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), topMat);
    head.scale.set(0.053, 0.024, 0.066); head.position.set(0, 0.043, -0.021); root.add(head);
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.041, 0.0015, 6, 40), accentMat);
    seam.rotation.x = Math.PI / 2; seam.scale.set(1.2, 1.4, 1); seam.position.set(0, 0.043, -0.021); root.add(seam);
    const direction = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.025, 12), accentMat);
    direction.rotation.x = -Math.PI / 2; direction.position.set(0, 0.044, -0.098); root.add(direction);
    const thumb = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.008, 0.009, 20), material(0x0e1722));
    thumb.position.set(side === 'left' ? -0.018 : 0.018, 0.067, -0.034); root.add(thumb);
    const buttonMeshes = {};
    const names = side === 'left' ? ['x', 'y'] : ['a', 'b'];
    names.forEach((name, index) => {
      const button = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.004, 16), material(0x89a0b7));
      button.position.set(side === 'left' ? 0.020 : -0.020, 0.065, index ? -0.045 : -0.020);
      buttonMeshes[name] = button; root.add(button);
    });
    const trigger = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), material(0x99adbd));
    trigger.scale.set(0.016, 0.020, 0.009); trigger.position.set(0, 0.005, -0.022); root.add(trigger);
    const axes = new THREE.AxesHelper(0.135); root.add(axes);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.15, accent, 0.035, 0.018);
    arrow.visible = false; scene.add(arrow);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(90 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    trailGeometry.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.58 }));
    trail.frustumCulled = false; scene.add(trail);
    const label = document.createElement('div'); label.className = 'hand-label'; label.style.setProperty('--accent', `#${accent.toString(16)}`); label.hidden = true; container.append(label);
    return { root, axes, arrow, trail, label, meshMaterials, buttonMeshes, thumb, trigger, points: [], lastSequence: null };
  }
  const hands = { left: buildController('left'), right: buildController('right') };
  const options = { trails: true, velocity: true, axes: true };
  let hasAutoFramed = false, lastConnection = null, lastReferenceChanges = null;
  const projected = new THREE.Vector3(), direction = new THREE.Vector3();

  function clearTrails() {
    for (const hand of Object.values(hands)) { hand.points = []; hand.lastSequence = null; hand.trail.geometry.setDrawRange(0, 0); }
  }
  function resetView() { camera.position.set(1.5, 1.05, 1.7); controls.target.set(0, -0.15, 0); controls.update(); }
  function frameHands() {
    const visible = Object.values(hands).filter(hand => hand.root.visible);
    if (!visible.length) { resetView(); return; }
    const bounds = new THREE.Box3();
    for (const hand of visible) bounds.expandByPoint(hand.root.position);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3()).length();
    const distance = Math.max(0.9, size * 2.4);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0.85, 0.65, 1.25).normalize().multiplyScalar(distance));
    controls.update();
  }
  resetView();
  const observer = new ResizeObserver(() => {
    const width = container.clientWidth, height = container.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
  });
  observer.observe(container);

  function update(view, snapshot) {
    if (snapshot?.connection_id !== lastConnection || snapshot?.frame?.reference_space_changes !== lastReferenceChanges) {
      clearTrails(); hasAutoFramed = false; lastConnection = snapshot?.connection_id; lastReferenceChanges = snapshot?.frame?.reference_space_changes;
    }
    for (const side of ['left', 'right']) {
      const object = hands[side], state = view[side], hand = state.hand;
      object.root.visible = state.visible;
      object.label.hidden = !state.visible;
      object.axes.visible = options.axes;
      object.arrow.visible = false;
      object.trail.visible = options.trails && state.key === 'tracked';
      if (!state.visible) { object.points = []; object.trail.geometry.setDrawRange(0, 0); continue; }
      object.root.position.fromArray(hand.position_m);
      object.root.quaternion.fromArray(hand.orientation_xyzw).normalize();
      const inferred = state.key !== 'tracked';
      for (const material of object.meshMaterials) {
        material.wireframe = inferred; material.transparent = inferred; material.opacity = inferred ? 0.30 : 1;
        material.color.set(inferred ? COLORS.inferred : material.userData.originalColor);
      }
      if (!inferred) for (const [name, mesh] of Object.entries(object.buttonMeshes)) {
        mesh.material.color.set(hand.buttons[name] ? COLORS[side] : mesh.material.userData.originalColor);
      }
      if (hand.thumbstick) object.thumb.rotation.set(hand.thumbstick[1] * 0.3, 0, -hand.thumbstick[0] * 0.3);
      object.trigger.rotation.x = (hand.trigger ?? 0) * 0.35;
      if (options.velocity && hand.linear_velocity_valid) {
        direction.fromArray(hand.linear_velocity_m_s);
        const speed = direction.length();
        if (speed > 0.02) {
          object.arrow.visible = true; object.arrow.position.copy(object.root.position);
          object.arrow.setDirection(direction.normalize());
          const length = speed * 0.15;
          object.arrow.setLength(length, Math.min(0.025, length * 0.3), Math.min(0.013, length * 0.15));
          object.arrow.setColor(inferred ? COLORS.inferred : COLORS[side]);
        }
      }
      const sequence = snapshot?.frame?.sequence;
      if (state.key === 'tracked' && object.lastSequence !== sequence) {
        const previous = object.points.at(-1);
        if (previous && previous.distanceTo(object.root.position) > 0.8) object.points = [];
        object.points.push(object.root.position.clone());
        if (object.points.length > 90) object.points.shift();
        object.lastSequence = sequence;
        const attribute = object.trail.geometry.attributes.position;
        object.points.forEach((point, index) => attribute.setXYZ(index, point.x, point.y, point.z));
        attribute.needsUpdate = true; object.trail.geometry.setDrawRange(0, object.points.length);
      } else if (inferred) { object.points = []; object.trail.geometry.setDrawRange(0, 0); }
      object.label.textContent = `${side === 'left' ? 'L / 左手' : 'R / 右手'}${inferred ? ' · 推算' : ''}`;
      object.label.dataset.tone = inferred ? 'warning' : 'good';
    }
    if (!hasAutoFramed && (view.left.key === 'tracked' || view.right.key === 'tracked')) { frameHands(); hasAutoFramed = true; }
  }
  function render() {
    controls.update();
    for (const hand of Object.values(hands)) {
      if (!hand.root.visible) continue;
      projected.copy(hand.root.position).add(new THREE.Vector3(0, 0.12, 0)).project(camera);
      const inView = Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z < 1;
      hand.label.hidden = !inView;
      hand.label.style.transform = `translate(${(projected.x * 0.5 + 0.5) * container.clientWidth}px,${(-projected.y * 0.5 + 0.5) * container.clientHeight}px) translate(-50%,-100%)`;
    }
    renderer.render(scene, camera);
  }
  return { update, render, frameHands, resetView, options };
}
