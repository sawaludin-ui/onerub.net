import * as THREE from 'three';

                                       
                                     
                                    
                                 
                                
                                     
                                    
                                          
                                   
                                    
                                   
                                     
                      
 

// Deterministic pseudo-random generator so textures are identical across reloads.
function mulberry32(seed        )               {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(size        )                                                {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire 2D canvas context');
  return [canvas, ctx];
}

function finalizeTexture(
  canvas                   ,
  isColor         ,
  anisotropy        ,
  repeat = false,
)                      {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  } else {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.needsUpdate = true;
  return tex;
}

function createTerrazzoTextures(anisotropy        )   
                             
                            
  {
  const size = 512;
  const [cCanvas, cCtx] = makeCanvas(size);
  const [bCanvas, bCtx] = makeCanvas(size);
  const rand = mulberry32(4109);

  cCtx.fillStyle = '#E4DFD5';
  cCtx.fillRect(0, 0, size, size);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  // Subtle organic mineral clouding
  for (let i = 0; i < 140; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 18 + rand() * 44;
    const grad = cCtx.createRadialGradient(x, y, 0, x, y, r);
    const tone = rand() > 0.5 ? 'rgba(255,252,245,0.08)' : 'rgba(175,168,155,0.09)';
    grad.addColorStop(0, tone);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    cCtx.fillStyle = grad;
    cCtx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Fine mineral terrazzo flecks
  const fleckPalette = [
    '#A49F95',
    '#78746D',
    '#BEA98E',
    '#8694A2',
    '#5E5B57',
    '#CCC6BA',
  ];

  for (let i = 0; i < 680; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const radius = 0.8 + rand() * 2.3;
    const color = fleckPalette[Math.floor(rand() * fleckPalette.length)];
    cCtx.fillStyle = color;
    cCtx.globalAlpha = 0.42 + rand() * 0.52;
    cCtx.beginPath();
    cCtx.ellipse(
      x,
      y,
      radius,
      radius * (0.65 + rand() * 0.6),
      rand() * Math.PI,
      0,
      Math.PI * 2,
    );
    cCtx.fill();

    // Corresponding micro-relief on bump map
    const bVal = Math.floor(110 + rand() * 40);
    bCtx.fillStyle = `rgb(${bVal},${bVal},${bVal})`;
    bCtx.globalAlpha = 0.4;
    bCtx.beginPath();
    bCtx.arc(x, y, radius, 0, Math.PI * 2);
    bCtx.fill();
  }
  cCtx.globalAlpha = 1;
  bCtx.globalAlpha = 1;

  return {
    color: finalizeTexture(cCanvas, true, anisotropy, true),
    bump: finalizeTexture(bCanvas, false, anisotropy, true),
  };
}

function createWoodBaseCanvases(size        , seed        )   
                             
                                 
                             
                                 
  {
  const [cCanvas, cCtx] = makeCanvas(size);
  const [bCanvas, bCtx] = makeCanvas(size);
  const rand = mulberry32(seed);

  const grad = cCtx.createLinearGradient(0, 0, size, 0);
  grad.addColorStop(0, '#DFC19B');
  grad.addColorStop(0.5, '#E5C9A5');
  grad.addColorStop(1, '#D9B990');
  cCtx.fillStyle = grad;
  cCtx.fillRect(0, 0, size, size);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  // Fine natural birch/oak grain streaks (horizontal)
  for (let i = 0; i < 240; i++) {
    const y = rand() * size;
    const thickness = 0.6 + rand() * 2.4;
    const isDark = rand() > 0.38;
    cCtx.strokeStyle = isDark
      ? `rgba(164, 121, 74, ${0.06 + rand() * 0.12})`
      : `rgba(248, 232, 206, ${0.07 + rand() * 0.1})`;
    cCtx.lineWidth = thickness;
    cCtx.beginPath();
    cCtx.moveTo(0, y);
    const waveAmp = 2 + rand() * 6;
    const waveFreq = 0.008 + rand() * 0.015;
    const phase = rand() * Math.PI * 2;
    for (let x = 0; x <= size; x += 24) {
      cCtx.lineTo(x, y + Math.sin(x * waveFreq + phase) * waveAmp);
    }
    cCtx.stroke();

    const bTone = isDark ? 108 : 146;
    bCtx.strokeStyle = `rgba(${bTone},${bTone},${bTone},0.22)`;
    bCtx.lineWidth = thickness;
    bCtx.beginPath();
    bCtx.moveTo(0, y);
    for (let x = 0; x <= size; x += 24) {
      bCtx.lineTo(x, y + Math.sin(x * waveFreq + phase) * waveAmp);
    }
    bCtx.stroke();
  }

  // Subtle wood pores
  for (let i = 0; i < 320; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 8 + rand() * 24;
    cCtx.strokeStyle = 'rgba(138, 97, 56, 0.16)';
    cCtx.lineWidth = 1;
    cCtx.beginPath();
    cCtx.moveTo(x, y);
    cCtx.lineTo(x + len, y + (rand() - 0.5) * 1.5);
    cCtx.stroke();
  }

  return { cCanvas, cCtx, bCanvas, bCtx };
}

function createCharcoalBaseCanvas(size        , seed        )   
                             
                                 
                             
                                 
  {
  const [cCanvas, cCtx] = makeCanvas(size);
  const [bCanvas, bCtx] = makeCanvas(size);
  const rand = mulberry32(seed);

  cCtx.fillStyle = '#121316';
  cCtx.fillRect(0, 0, size, size);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  // Subtle matte anodized micro-grain
  for (let i = 0; i < 900; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.6 + rand() * 1.2;
    const v = Math.floor(14 + rand() * 14);
    cCtx.fillStyle = `rgba(${v},${v + 1},${v + 2},0.38)`;
    cCtx.fillRect(x, y, r, r);

    const b = Math.floor(118 + rand() * 20);
    bCtx.fillStyle = `rgb(${b},${b},${b})`;
    bCtx.fillRect(x, y, r, r);
  }

  return { cCanvas, cCtx, bCanvas, bCtx };
}

function createMicroBump(anisotropy        )                      {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  const rand = mulberry32(9912);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 1400; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const v = Math.floor(120 + rand() * 16);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x, y, 2, 2);
  }
  return finalizeTexture(canvas, false, anisotropy, true);
}

function createBrandTexture(
  brand                                ,
  anisotropy        ,
)                      {
  const size = 1024;
  if (brand === 'workday') {
    const { cCanvas, cCtx } = createWoodBaseCanvases(size, 7721);
    // Workday charcoal wordmark + signature arch above
    cCtx.save();
    cCtx.fillStyle = '#1E1D1B';
    cCtx.strokeStyle = '#1E1D1B';
    cCtx.textAlign = 'center';
    cCtx.textBaseline = 'middle';

    // Signature curved arch above "workday"
    cCtx.lineWidth = 22;
    cCtx.lineCap = 'round';
    cCtx.beginPath();
    cCtx.arc(size * 0.5, size * 0.455, 118, Math.PI * 1.15, Math.PI * 1.85);
    cCtx.stroke();

    // Wordmark
    cCtx.font = '700 138px "Plus Jakarta Sans", "DM Sans", sans-serif';
    cCtx.fillText('workday', size * 0.5, size * 0.535);
    cCtx.restore();
    return finalizeTexture(cCanvas, true, anisotropy, false);
  }

  if (brand === 'ONERUB') {
    const { cCanvas, cCtx } = createCharcoalBaseCanvas(size, 3317);
    cCtx.save();
    cCtx.fillStyle = '#F7F5F0';
    cCtx.textAlign = 'center';
    cCtx.textBaseline = 'middle';
    cCtx.font = '700 132px "Plus Jakarta Sans", "DM Sans", sans-serif';
    // Slight letter-spacing simulation for crisp architectural feel
    const text = 'ONERUB';
    const tracking = 10;
    const widths = Array.from(text).map((ch) => cCtx.measureText(ch).width);
    const totalWidth =
      widths.reduce((a, b) => a + b, 0) + tracking * (text.length - 1);
    let cursorX = size * 0.5 - totalWidth * 0.5;
    for (let i = 0; i < text.length; i++) {
      cCtx.fillText(text[i], cursorX + widths[i] * 0.5, size * 0.51);
      cursorX += widths[i] + tracking;
    }
    cCtx.restore();
    return finalizeTexture(cCanvas, true, anisotropy, false);
  }

  // ORACLE
  const { cCanvas, cCtx } = createCharcoalBaseCanvas(size, 5519);
  cCtx.save();
  cCtx.fillStyle = '#F7F5F0';
  cCtx.textAlign = 'center';
  cCtx.textBaseline = 'middle';
  cCtx.font = '700 132px "Plus Jakarta Sans", "DM Sans", sans-serif';
  const text = 'ORACLE';
  const tracking = 14;
  const widths = Array.from(text).map((ch) => cCtx.measureText(ch).width);
  const totalWidth =
    widths.reduce((a, b) => a + b, 0) + tracking * (text.length - 1);
  let cursorX = size * 0.5 - totalWidth * 0.5;
  for (let i = 0; i < text.length; i++) {
    cCtx.fillText(text[i], cursorX + widths[i] * 0.5, size * 0.51);
    cursorX += widths[i] + tracking;
  }
  cCtx.restore();
  return finalizeTexture(cCanvas, true, anisotropy, false);
}

function createContactShadowTexture(anisotropy        )                      {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const center = size * 0.5;
  const grad = ctx.createRadialGradient(center, center, 10, center, center, center);
  grad.addColorStop(0, 'rgba(18, 18, 22, 0.28)');
  grad.addColorStop(0.38, 'rgba(18, 18, 22, 0.14)');
  grad.addColorStop(0.7, 'rgba(18, 18, 22, 0.04)');
  grad.addColorStop(1, 'rgba(18, 18, 22, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return finalizeTexture(canvas, true, anisotropy, false);
}

export function createProceduralTextures(anisotropy        )                       {
  const terrazzo = createTerrazzoTextures(anisotropy);
  const wood = createWoodBaseCanvases(512, 7721);
  const woodColor = finalizeTexture(wood.cCanvas, true, anisotropy, true);
  const woodBump = finalizeTexture(wood.bCanvas, false, anisotropy, true);
  const charcoal = createCharcoalBaseCanvas(512, 3317);
  const charcoalColor = finalizeTexture(charcoal.cCanvas, true, anisotropy, true);
  const charcoalBump = finalizeTexture(charcoal.bCanvas, false, anisotropy, true);
  const microRoughnessBump = createMicroBump(anisotropy);

  const brandOnerub = createBrandTexture('ONERUB', anisotropy);
  const brandWorkday = createBrandTexture('workday', anisotropy);
  const brandOracle = createBrandTexture('ORACLE', anisotropy);
  const contactShadow = createContactShadowTexture(anisotropy);

  const all = [
    terrazzo.color,
    terrazzo.bump,
    woodColor,
    woodBump,
    charcoalColor,
    charcoalBump,
    microRoughnessBump,
    brandOnerub,
    brandWorkday,
    brandOracle,
    contactShadow,
  ];

  return {
    terrazzoColor: terrazzo.color,
    terrazzoBump: terrazzo.bump,
    woodColor,
    woodBump,
    charcoalColor,
    charcoalBump,
    microRoughnessBump,
    brandOnerub,
    brandWorkday,
    brandOracle,
    contactShadow,
    dispose: () => {
      for (const tex of all) {
        tex.dispose();
      }
    },
  };
}
