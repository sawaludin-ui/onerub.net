import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  HEX_DIMENSIONS,
  RING_PRESETS,
  TileMaterialKind,
  evaluateTilePose,
} from './loopMath.js';
import { ProceduralTextureSet, createProceduralTextures } from './textures.js';

                                
                   
                          
                     
 

                                     
                                                             
                          
                         
                      
 

function detectSoftwareGl()          {
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
}

function createRoundedRectShape(width        , height        , radius        )              {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const r = Math.min(radius, hw * 0.45, hh * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return shape;
}

function createBeveledBlockGeometry(
  width        ,
  height        ,
  depth        ,
)                       {
  const bevel = 0.022;
  const shape = createRoundedRectShape(width - bevel * 2, height - bevel * 2, 0.025);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 8,
  });
  geo.center();

  // Normalize UVs so procedural textures tile naturally at consistent scale
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * 0.9 + 0.5, uv.getY(i) * 0.9 + 0.5);
  }
  uv.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function createNormalizedPlateGeometry(width        , height        , radius        )                       {
  const shape = createRoundedRectShape(width, height, radius);
  const geo = new THREE.ShapeGeometry(shape, 8);
  const pos = geo.attributes.position;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    uvs[i * 2] = (x + width * 0.5) / width;
    uvs[i * 2 + 1] = (y + height * 0.5) / height;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

                    
                     
                    
                    
 

const DEFAULT_CAMERA_POS = new THREE.Vector3(0.7, 3.05, 9.5);
const DEFAULT_TARGET = new THREE.Vector3(0, -0.38, 0);

export function mountHexTowerScene(
  container             ,
  initialSettings               ,
  onContextLostChange                          ,
)                     {
  const isSoftwareGl = detectSoftwareGl();

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: !isSoftwareGl,
    powerPreference: 'high-performance',
    premultipliedAlpha: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const width = Math.max(container.clientWidth, 1);
  const height = Math.max(container.clientHeight, 1);
  renderer.setSize(width, height);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = null;

  // Studio environment reflections (RoomEnvironment kept on all devices per threejs skill)
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTex = pmremGenerator.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = envTex;
  scene.environmentIntensity = 0.56;
  pmremGenerator.dispose();

  const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
  camera.position.copy(DEFAULT_CAMERA_POS);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(DEFAULT_TARGET);
  controls.enablePan = false;
  controls.enableDamping = !isSoftwareGl;
  controls.dampingFactor = 0.07;
  controls.minDistance = 4.2;
  controls.maxDistance = 14.0;
  controls.minPolarAngle = Math.PI * 0.12;
  controls.maxPolarAngle = Math.PI * 0.72;
  controls.update();

  // Three-point studio lighting rig with warm/cool contrast
  const hemiLight = new THREE.HemisphereLight(0xeef5ff, 0xd9d2c7, 0.78);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xfff7ea, 1.55);
  keyLight.position.set(4.5, 7.2, 5.4);
  if (!isSoftwareGl) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 20;
    const d = 4.0;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.025;
  }
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xdfecff, 0.58);
  fillLight.position.set(-5.0, 2.5, 4.0);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xf6f9ff, 0.88);
  rimLight.position.set(-2.4, 5.5, -5.2);
  scene.add(rimLight);

  // Procedural PBR textures
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const textures                       = createProceduralTextures(maxAniso);

  // Soft transparent contact shadow disc beneath the floating tower
  const shadowGeo = new THREE.PlaneGeometry(5.0, 5.0);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: textures.contactShadow,
    transparent: true,
    depthWrite: false,
    opacity: 0.52,
  });
  const contactShadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  contactShadowMesh.rotation.x = -Math.PI / 2;
  contactShadowMesh.position.set(0, -2.35, 0);
  scene.add(contactShadowMesh);

  // Shared materials library
  const outerMaterials                                                       = {
    terrazzo: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: textures.terrazzoColor,
      bumpMap: textures.terrazzoBump,
      bumpScale: 0.009,
      roughness: 0.72,
      metalness: 0.02,
      clearcoat: 0.08,
      clearcoatRoughness: 0.6,
    }),
    charcoal: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: textures.charcoalColor,
      bumpMap: textures.charcoalBump,
      bumpScale: 0.005,
      roughness: 0.74,
      metalness: 0.04,
      envMapIntensity: 0.55,
      clearcoat: 0.06,
      clearcoatRoughness: 0.65,
    }),
    wood: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: textures.woodColor,
      bumpMap: textures.woodBump,
      bumpScale: 0.012,
      roughness: 0.68,
      metalness: 0.0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.45,
    }),
    yellow: new THREE.MeshPhysicalMaterial({
      color: 0xf6d436,
      bumpMap: textures.microRoughnessBump,
      bumpScale: 0.003,
      roughness: 0.38,
      metalness: 0.02,
      clearcoat: 0.25,
      clearcoatRoughness: 0.32,
    }),
    green: new THREE.MeshPhysicalMaterial({
      color: 0x5cbf67,
      bumpMap: textures.microRoughnessBump,
      bumpScale: 0.003,
      roughness: 0.4,
      metalness: 0.02,
      clearcoat: 0.25,
      clearcoatRoughness: 0.32,
    }),
    slate: new THREE.MeshPhysicalMaterial({
      color: 0x4c5057,
      bumpMap: textures.microRoughnessBump,
      bumpScale: 0.004,
      roughness: 0.66,
      metalness: 0.05,
      clearcoat: 0.1,
      clearcoatRoughness: 0.5,
    }),
  };

  const brandMaterials = {
    ONERUB: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: textures.brandOnerub,
      bumpMap: textures.charcoalBump,
      bumpScale: 0.004,
      roughness: 0.72,
      metalness: 0.04,
      envMapIntensity: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    workday: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: textures.brandWorkday,
      bumpMap: textures.woodBump,
      bumpScale: 0.008,
      roughness: 0.65,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    ORACLE: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: textures.brandOracle,
      bumpMap: textures.charcoalBump,
      bumpScale: 0.004,
      roughness: 0.72,
      metalness: 0.04,
      envMapIntensity: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  };

  const innerPanelMaterialCache = new Map                                    ();
  function getInnerPanelMaterial(hexColor        )                             {
    let mat = innerPanelMaterialCache.get(hexColor);
    if (!mat) {
      mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(hexColor),
        roughness: 0.28,
        metalness: 0.02,
        clearcoat: 0.42,
        clearcoatRoughness: 0.24,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      innerPanelMaterialCache.set(hexColor, mat);
    }
    return mat;
  }

  // Rim frame material for inner inset surround (subtle satin architectural trim)
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4f1ea,
    roughness: 0.52,
    metalness: 0.04,
  });

  // Shared geometries
  const { tileWidth, tileHeight, tileDepth, ringCount, tileCountPerRing } = HEX_DIMENSIONS;
  const blockGeo = createBeveledBlockGeometry(tileWidth, tileHeight, tileDepth);
  const brandPlateGeo = createNormalizedPlateGeometry(
    tileWidth - 0.055,
    tileHeight - 0.055,
    0.02,
  );
  const innerRimGeo = createNormalizedPlateGeometry(
    tileWidth - 0.1,
    tileHeight - 0.1,
    0.025,
  );
  const innerInsetGeo = createNormalizedPlateGeometry(
    tileWidth - 0.17,
    tileHeight - 0.17,
    0.02,
  );

  // Root tower group for subtle optional turntable rotation
  const towerRoot = new THREE.Group();
  // Slight initial yaw so front-right hero face (ONERUB/workday/ORACLE) reads cleanly
  towerRoot.rotation.y = -0.14;
  scene.add(towerRoot);

  const tileNodes             = [];

  for (let r = 0; r < ringCount; r++) {
    const preset = RING_PRESETS[r];
    for (let t = 0; t < tileCountPerRing; t++) {
      const spec = preset.tiles[t];
      const tileGroup = new THREE.Group();

      // 1. Primary beveled body
      const bodyMesh = new THREE.Mesh(blockGeo, outerMaterials[spec.outerKind]);
      bodyMesh.castShadow = !isSoftwareGl;
      bodyMesh.receiveShadow = !isSoftwareGl;
      tileGroup.add(bodyMesh);

      // 2. Outer faceplate for crisp typography (ONERUB, workday, ORACLE)
      if (spec.brand !== 'none') {
        const brandMesh = new THREE.Mesh(brandPlateGeo, brandMaterials[spec.brand]);
        brandMesh.position.z = tileDepth * 0.5 + 0.0015;
        brandMesh.receiveShadow = !isSoftwareGl;
        tileGroup.add(brandMesh);
      }

      // 3. Inner architectural trim + recessed pastel/vibrant color inset (facing inward -Z)
      const rimMesh = new THREE.Mesh(innerRimGeo, trimMaterial);
      rimMesh.rotation.y = Math.PI;
      rimMesh.position.z = -tileDepth * 0.5 - 0.001;
      tileGroup.add(rimMesh);

      const insetMesh = new THREE.Mesh(
        innerInsetGeo,
        getInnerPanelMaterial(spec.innerColor),
      );
      insetMesh.rotation.y = Math.PI;
      insetMesh.position.z = -tileDepth * 0.5 - 0.0025;
      tileGroup.add(insetMesh);

      towerRoot.add(tileGroup);
      tileNodes.push({
        group: tileGroup,
        ringIndex: r,
        tileIndex: t,
      });
    }
  }

  // Pre-allocated math helpers (zero GC inside animation loop)
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _targetCamPos = new THREE.Vector3().copy(DEFAULT_CAMERA_POS);
  const _targetLook = new THREE.Vector3().copy(DEFAULT_TARGET);

  const state                = { ...initialSettings };
  let globalPhase = 0.08;
  let currentSpeed = initialSettings.playing ? initialSettings.speedMultiplier : 0;
  let resettingCamera = false;
  let disposed = false;
  let frameId = 0;

  const BASE_CYCLES_PER_SECOND = 0.145; // Smooth, unhurried architectural tempo (~6.9s full 6-tier cycle)

  function updateTiles(phase        ) {
    for (let i = 0; i < tileNodes.length; i++) {
      const node = tileNodes[i];
      const ringPhase = phase + node.ringIndex / ringCount;
      const pose = evaluateTilePose(ringPhase, node.tileIndex);

      const sinA = Math.sin(pose.azimuth);
      const cosA = Math.cos(pose.azimuth);
      node.group.position.set(sinA * pose.radius, pose.y, cosA * pose.radius);

      // Rotate around Y to face radially outward (+Z -> radial outward), then tiltX/rollZ locally
      _euler.set(pose.tiltX, pose.azimuth, pose.rollZ, 'YXZ');
      node.group.quaternion.setFromEuler(_euler);
    }
  }

  // Initial pose evaluation & shader pre-warm
  updateTiles(globalPhase);
  if (!isSoftwareGl) {
    renderer.compile(scene, camera);
  }

  const onControlsStart = () => {
    resettingCamera = false;
  };
  controls.addEventListener('start', onControlsStart);

  const onResize = () => {
    if (disposed) return;
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(container);

  const onContextLost = (e       ) => {
    e.preventDefault();
    onContextLostChange?.(true);
  };
  const onContextRestored = () => {
    onContextLostChange?.(false);
  };
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

  function afterDraw(cb            ) {
    const gl = renderer.getContext()                          ;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      frameId = window.setTimeout(cb, 80);
      return;
    }
    gl.flush();
    const poll = () => {
      if (disposed) {
        gl.deleteSync(sync);
        return;
      }
      const syncState = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (syncState === gl.UNSIGNALED) {
        frameId = window.setTimeout(poll, 5);
      } else {
        gl.deleteSync(sync);
        frameId = window.setTimeout(cb, 80);
      }
    };
    frameId = window.setTimeout(poll, 5);
  }

  let lastTime = performance.now();

  function tick() {
    if (disposed) return;

    const now = performance.now();
    const rawDelta = (now - lastTime) * 0.001;
    lastTime = now;
    const delta = Math.min(Math.max(rawDelta, 0.001), 0.1);

    const targetSpeed = state.playing ? state.speedMultiplier : 0;
    currentSpeed = THREE.MathUtils.damp(currentSpeed, targetSpeed, 7, delta);
    globalPhase = (globalPhase + delta * BASE_CYCLES_PER_SECOND * currentSpeed) % 1;

    if (state.turntable) {
      towerRoot.rotation.y += delta * 0.28 * Math.max(0.25, currentSpeed);
    }

    if (resettingCamera) {
      const k = 1 - Math.exp(-6.5 * delta);
      camera.position.lerp(_targetCamPos, k);
      controls.target.lerp(_targetLook, k);
      if (
        camera.position.distanceTo(_targetCamPos) < 0.01 &&
        controls.target.distanceTo(_targetLook) < 0.01
      ) {
        camera.position.copy(_targetCamPos);
        controls.target.copy(_targetLook);
        resettingCamera = false;
      }
    }

    updateTiles(globalPhase);
    controls.update();
    renderer.render(scene, camera);
    renderer.domElement.dataset.engine = 'supplied-hexagonal-loop';
    renderer.domElement.dataset.phase = globalPhase.toFixed(5);

    if (isSoftwareGl) {
      afterDraw(tick);
    } else {
      frameId = requestAnimationFrame(tick);
    }
  }

  if (isSoftwareGl) {
    renderer.render(scene, camera);
    afterDraw(tick);
  } else {
    frameId = requestAnimationFrame(tick);
  }

  return {
    updateSettings: (partial) => {
      Object.assign(state, partial);
    },
    resetCamera: () => {
      resettingCamera = true;
      towerRoot.rotation.y = -0.14;
    },
    getPhase: () => globalPhase,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      controls.removeEventListener('start', onControlsStart);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      controls.dispose();

      blockGeo.dispose();
      brandPlateGeo.dispose();
      innerRimGeo.dispose();
      innerInsetGeo.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      trimMaterial.dispose();
      Object.values(outerMaterials).forEach((m) => m.dispose());
      Object.values(brandMaterials).forEach((m) => m.dispose());
      innerPanelMaterialCache.forEach((m) => m.dispose());
      textures.dispose();
      envTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}
