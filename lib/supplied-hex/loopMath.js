                                                                     

                              
              
              
          
            
           
            

                           
                              
                     
                       
 

                             
             
               
                                                                               
 

                                     
                    
                           
                    
                     
                    
                   
                       
                     
                       
 

export const HEX_DIMENSIONS                     = {
  ringCount: 6,
  tileCountPerRing: 6,
  tileWidth: 0.74,
  tileHeight: 0.68,
  tileDepth: 0.44,
  rowPitch: 0.70,
  innerApothem: 0.62,
  dockRadius: 0.62 + 0.44 / 2,
  coreEndPhase: 0.66,
};

/**
 * Face indices around the hexagon (angle = index * 60deg + 30deg):
 * 0: Front-Right (+30deg) - Primary hero typography face
 * 1: Right (+90deg)
 * 2: Back-Right (+150deg)
 * 3: Back-Left (+210deg)
 * 4: Left (+270deg)
 * 5: Front-Left (+330deg)
 */
export const RING_PRESETS                        = [
  {
    id: 'stone-top',
    name: 'Terrazzo Stone',
    tiles: [
      { outerKind: 'terrazzo', innerColor: '#8BE0F8', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#F6D436', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#5CBF67', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#E94E9B', brand: 'none' },
    ],
  },
  {
    id: 'black-onerub',
    name: 'ONERUB Charcoal',
    tiles: [
      { outerKind: 'charcoal', innerColor: '#8BE0F8', brand: 'ONERUB' },
      { outerKind: 'charcoal', innerColor: '#F6D436', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#5CBF67', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#8BE0F8', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#E94E9B', brand: 'none' },
    ],
  },
  {
    id: 'wood-workday',
    name: 'Oak Workday',
    tiles: [
      { outerKind: 'wood', innerColor: '#8BE0F8', brand: 'workday' },
      { outerKind: 'wood', innerColor: '#F6D436', brand: 'none' },
      { outerKind: 'wood', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'wood', innerColor: '#5CBF67', brand: 'none' },
      { outerKind: 'wood', innerColor: '#F6D436', brand: 'none' },
      { outerKind: 'wood', innerColor: '#E94E9B', brand: 'none' },
    ],
  },
  {
    id: 'vivid-yellow-green',
    name: 'Yellow & Green Modules',
    tiles: [
      { outerKind: 'yellow', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'yellow', innerColor: '#8BE0F8', brand: 'none' },
      { outerKind: 'yellow', innerColor: '#5CBF67', brand: 'none' },
      { outerKind: 'yellow', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'green', innerColor: '#F6D436', brand: 'none' },
      { outerKind: 'green', innerColor: '#8BE0F8', brand: 'none' },
    ],
  },
  {
    id: 'black-oracle',
    name: 'ORACLE Charcoal',
    tiles: [
      { outerKind: 'charcoal', innerColor: '#E94E9B', brand: 'ORACLE' },
      { outerKind: 'charcoal', innerColor: '#8BE0F8', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#F6D436', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#5CBF67', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'charcoal', innerColor: '#8BE0F8', brand: 'none' },
    ],
  },
  {
    id: 'stone-accent',
    name: 'Stone & Pastel Inset',
    tiles: [
      { outerKind: 'terrazzo', innerColor: '#8BE0F8', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#F6D436', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#E94E9B', brand: 'none' },
      { outerKind: 'slate', innerColor: '#8BE0F8', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#5CBF67', brand: 'none' },
      { outerKind: 'terrazzo', innerColor: '#E94E9B', brand: 'none' },
    ],
  },
];

                           
                                                     
            
                                                                 
                 
                                                           
                  
                                                                                                      
                
                                                               
                
                                                                    
                      
                                                                       
                         
 

export function wrapPhase(value        )         {
  const m = value % 1;
  return m < 0 ? m + 1 : m;
}

export function smootherstep(t        )         {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Cubic Hermite interpolation on [0, 1] with exact endpoint values and derivatives.
 */
function hermite(
  t        ,
  p0        ,
  m0        ,
  p1        ,
  m1        ,
)         {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

// Per-tile organic stagger so the 6 tiles peel like synchronized petals rather than a rigid washer.
const TILE_STAGGER_TABLE = [0.0, 0.008, 0.014, 0.010, 0.004, -0.006]         ;

/**
 * Computes the exact periodic C^1-continuous 3D pose of a tile for any phase u in (-inf, +inf).
 *
 * Inside the core [0, coreEndPhase]:
 *   4 rings sit flush in a hexagonal stack from +1.85*rowPitch down to -2.11*rowPitch.
 *
 * In exterior flight (coreEndPhase, 1):
 *   1. Peel outward at bottom (s in [0, 0.22]): hinges outward radially revealing pastel inner face.
 *   2. Upward glide (s in [0.22, 0.76]): travels steadily UPWARD (+Y) alongside the tower.
 *   3. Over-the-top arc & dock (s in [0.76, 1.0]): arches inward over the top and reconnects flush at TOP_Y.
 */
export function evaluateTilePose(
  ringPhase        ,
  tileIndex        ,
  dims                     = HEX_DIMENSIONS,
)           {
  const idx = ((tileIndex % dims.tileCountPerRing) + dims.tileCountPerRing) % dims.tileCountPerRing;
  const baseAzimuth = idx * ((Math.PI * 2) / dims.tileCountPerRing) + Math.PI / 6;

  const rawU = wrapPhase(ringPhase);
  const { ringCount, rowPitch, dockRadius, coreEndPhase } = dims;
  const topY = 1.85 * rowPitch;
  const coreSlopePerPhase = -ringCount * rowPitch;

  if (rawU <= coreEndPhase) {
    return {
      y: topY + rawU * coreSlopePerPhase,
      radius: dockRadius,
      azimuth: baseAzimuth,
      tiltX: 0,
      rollZ: 0,
      isDetached: false,
      flightProgress: 0,
    };
  }

  const flightSpan = 1 - coreEndPhase;
  const sBase = (rawU - coreEndPhase) / flightSpan; // (0, 1)

  // Smoothly blend stagger in and out with zero endpoint derivative so s=0 and s=1 are strictly C1-continuous.
  const sinPi = Math.sin(Math.PI * sBase);
  const staggerWeight = sinPi * sinPi;
  const staggerOffset = TILE_STAGGER_TABLE[idx] * staggerWeight;
  const s = Math.max(0, Math.min(1, sBase + staggerOffset));

  // Core boundary states
  const yStart = topY + coreEndPhase * coreSlopePerPhase;
  const yEnd = topY;
  const mCore = coreSlopePerPhase * flightSpan; // dy/ds at s=0 and s=1

  // Flight control knots in s
  const s1 = 0.22;
  const s2 = 0.76;

  const y1 = -1.75 * rowPitch;
  const m1 = 5.4 * rowPitch; // smooth upward climb entry velocity

  const y2 = 2.82 * rowPitch;
  const m2 = 3.2 * rowPitch; // upward climb exit velocity before arching over top

  let y        ;
  if (s <= s1) {
    const t = s / s1;
    y = hermite(t, yStart, mCore * s1, y1, m1 * s1);
  } else if (s <= s2) {
    const t = (s - s1) / (s2 - s1);
    const segLen = s2 - s1;
    y = hermite(t, y1, m1 * segLen, y2, m2 * segLen);
  } else {
    const t = (s - s2) / (1 - s2);
    const segLen = 1 - s2;
    y = hermite(t, y2, m2 * segLen, yEnd, mCore * segLen);
  }

  // Compact radial outward expansion: safely clears the hexagonal corners (1.12) while hugging close to the tower.
  const maxRadialClearance = 0.76;
  let radialClearance        ;
  if (s < 0.22) {
    radialClearance = maxRadialClearance * smootherstep(s / 0.22);
  } else if (s <= 0.76) {
    const mid = Math.sin(Math.PI * ((s - 0.22) / (0.76 - 0.22)));
    radialClearance = maxRadialClearance + 0.08 * mid;
  } else {
    radialClearance = maxRadialClearance * (1 - smootherstep((s - 0.76) / 0.24));
  }

  // Hinge tilt: peel outward (+0.74 rad) -> level toward upward glide -> tilt inward (-0.64 rad) over top rim -> 0
  let tiltX        ;
  if (s < 0.22) {
    tiltX = hermite(s / 0.22, 0, 0, 0.74, -0.15);
  } else if (s <= 0.76) {
    const t = (s - 0.22) / (0.76 - 0.22);
    tiltX = hermite(t, 0.74, -0.15 * 0.54, -0.64, -0.45 * 0.54);
  } else {
    const t = (s - 0.76) / 0.24;
    tiltX = hermite(t, -0.64, -0.45 * 0.24, 0, 0);
  }

  // Subtle organic sway in rollZ only mid-flight (zero at both boundaries)
  const rollZ = Math.sin(Math.PI * s) * (idx % 2 === 0 ? 0.05 : -0.05);

  return {
    y,
    radius: dockRadius + radialClearance,
    azimuth: baseAzimuth,
    tiltX,
    rollZ,
    isDetached: true,
    flightProgress: s,
  };
}
