"""Build the editable ONERUB mechanical sculpture and its animated glTF.
Run with Blender --background --python scripts/art/build_office_blender.py.
Fifty rigid wedges: ten pentagonal tiers, continuously recycling bottom to top.
"""
import bpy
import math
import numpy as np
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/sculpture'
EDITABLE = ROOT / 'artifacts'
EDITABLE.mkdir(exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.fps = 30
scene.frame_start, scene.frame_end = 0, 900
scene.render.film_transparent = True

def material(name, color, roughness=.65):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = roughness
    return m

def texture(material, name, pixels):
    h, w, _ = pixels.shape
    img = bpy.data.images.new(name, width=w, height=h, alpha=True)
    img.pixels.foreach_set(np.concatenate((pixels, np.ones((h,w,1))),axis=2).astype(np.float32).ravel())
    img.pack()
    node = material.node_tree.nodes.new('ShaderNodeTexImage')
    node.image = img
    material.node_tree.links.new(node.outputs['Color'], material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])

rng = np.random.default_rng(617)
stone = material('Warm ivory terrazzo', (.83,.82,.78))
pixels = np.ones((512,512,3)) * np.array([.88,.87,.83])
pixels += rng.normal(0,.006,(512,512,1))
for _ in range(3800):
    x,y = rng.integers(2,509,2)
    size = int(rng.choice([1,1,1,2]))
    pixels[y:y+size,x:x+size] *= rng.uniform(.48,.85)
texture(stone,'Terrazzo aggregate',np.clip(pixels,0,1))
wood = material('Natural oak', (.65,.46,.28), .72)
y,x = np.mgrid[0:512,0:512]/512
grain = .018*np.sin(y*320 + 4*np.sin(x*7)) + .012*np.sin(y*760 + 6*np.cos(x*5))
grain += rng.normal(0,.005,(512,512))
texture(wood,'Continuous oak grain',np.clip(np.array([.73,.56,.37])+grain[:,:,None],0,1))
black = material('Charcoal ceramic', (.023,.025,.024), .48)
ink = material('Warm white lettering',(.85,.84,.78),.65)
yellow = material('Golden yellow',(.98,.59,.012),.4)
green = material('Leaf green',(.15,.58,.20),.46)
pink = material('Pink insert',(.93,.24,.47),.46)
dark = material('Recess shadow',(.105,.09,.08),.85)

def finish(obj, mat, bevel=.018):
    obj.data.materials.append(mat)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    if bevel:
        mod = obj.modifiers.new('Small manufactured edge','BEVEL')
        mod.width, mod.segments = bevel, 3
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # Project each face along its dominant normal for stable material coordinates.
    uv = obj.data.uv_layers.new(name='Surface coordinates')
    for face in obj.data.polygons:
        dominant = max(range(3), key=lambda k:abs(face.normal[k]))
        axes = [a for a in range(3) if a != dominant]
        for li in face.loop_indices:
            pos = obj.data.vertices[obj.data.loops[li].vertex_index].co
            uv.data[li].uv = (pos[axes[0]]*.65+.5,pos[axes[1]]*.65+.5)
        face.use_smooth = False
    obj.select_set(False)
    return obj

def wedge(name, theta, bottom, height, mat, parent=None):
    points = []
    for offset,radius in [(-35.5,1.38),(35.5,1.38),(35.5,.48),(-35.5,.48)]:
        a = theta+math.radians(offset)
        points.append((math.cos(a)*radius,math.sin(a)*radius))
    verts = [(x,y,z) for z in [bottom,bottom+height] for x,y in points]
    n=len(points)
    faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
    faces.extend((i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n))
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(verts,[],faces)
    mesh.update()
    obj=bpy.data.objects.new(name,mesh)
    scene.collection.objects.link(obj)
    finish(obj,mat,.012)
    if parent:
        # Keep the world geometry while placing the mesh around its hinge origin.
        for v in obj.data.vertices:
            v.co = parent.matrix_world.inverted() @ v.co
        obj.parent=parent
    return obj

# Exactly five independent segments per tier, ten tiers.
TIERS, SIDES, PITCH, HEIGHT = 10, 5, .28, .258
STEP_FRAMES, CYCLE_FRAMES = 90, 900
palette = [stone,wood,black,yellow,stone,green,black,wood,pink,stone]
parts=[]
for row in range(TIERS):
    for side in range(SIDES):
        theta=math.tau*side/SIDES
        carrier=bpy.data.objects.new(f'Tier {row+1:02d} segment {side+1}',None)
        scene.collection.objects.link(carrier)
        obj=wedge(f'Pentagon {row+1:02d}.{side+1}',theta,0,HEIGHT,palette[row])
        obj.parent=carrier
        if palette[row] == black:
            curve=bpy.data.curves.new('ONERUB lettering','FONT')
            curve.body='ONERUB.NET'
            curve.align_x='CENTER'
            curve.size=.105
            curve.extrude=.0008
            label=bpy.data.objects.new(f'Brand {row+1:02d}.{side+1}',curve)
            scene.collection.objects.link(label)
            radius=1.38*math.cos(math.radians(35.5))+.003
            label.location=(radius*math.cos(theta),radius*math.sin(theta),.085)
            label.rotation_euler=Matrix(((-math.sin(theta),0,math.cos(theta)),(math.cos(theta),0,math.sin(theta)),(0,1,0))).to_euler()
            curve.materials.append(ink)
            bpy.context.view_layer.objects.active=label
            label.select_set(True)
            bpy.ops.object.convert(target='MESH')
            label.select_set(False)
            label.parent=carrier
        parts.append((carrier,row,theta))

def ease(x):
    x=max(0,min(1,x))
    return x*x*x*(x*(x*6-15)+10)

def pose(row,theta,time):
    step=int(math.floor(time)) % TIERS
    u=time-math.floor(time)
    slot=(row-step) % TIERS
    if slot==0:
        # Out, up, in: each piece has a separate clear radial lane.
        radial=1.48*(ease(u/.22) if u<.22 else (1-ease((u-.78)/.22)) if u>.78 else 1)
        z=(TIERS-1)*PITCH*ease((u-.22)/.56)
    else:
        radial=0
        z=(slot-ease((u-.22)/.56))*PITCH
    return (radial*math.cos(theta),radial*math.sin(theta),z)

for frame in range(CYCLE_FRAMES+1):
    time=frame/STEP_FRAMES
    for carrier,row,theta in parts:
        carrier.location=pose(row,theta,time)
        carrier.keyframe_insert(data_path='location',frame=frame,group='Bottom to top circulation')
for carrier,row,theta in parts:
    assert max(abs(a-b) for a,b in zip(pose(row,theta,0),pose(row,theta,10)))<1e-9
    for step in range(1,11):
        assert max(abs(a-b) for a,b in zip(pose(row,theta,step-1e-7),pose(row,theta,step)))<1e-6
assert len(parts)==50
scene.frame_set(0)

root=bpy.data.objects.new('ONERUB sculpture',None)
scene.collection.objects.link(root)
for obj in list(scene.objects):
    if obj != root and obj.parent is None:
        obj.parent=root
root.scale=(.86,.86,1.10)

def area(name,position,power,size):
    data=bpy.data.lights.new(name,'AREA')
    data.energy=power
    data.shape='DISK'
    data.size=size
    obj=bpy.data.objects.new(name,data)
    scene.collection.objects.link(obj)
    obj.location=position
    obj.rotation_euler=(Vector((0,0,1.4))-obj.location).to_track_quat('-Z','Y').to_euler()
area('Large softbox',(-3,-4,7),700,5)
area('Soft fill',(4,-1,4),350,4)
area('Top rim',(1,4,6),500,3)
scene.world.color=(.35,.35,.35)
camera_data=bpy.data.cameras.new('Studio camera')
camera=bpy.data.objects.new('Studio camera',camera_data)
scene.collection.objects.link(camera)
camera.location=(4,-7,5.0)
camera.rotation_euler=(Vector((0,0,1.55))-camera.location).to_track_quat('-Z','Y').to_euler()
camera_data.type='ORTHO'
camera_data.ortho_scale=5.0
scene.camera=camera
scene.render.engine='CYCLES'
scene.cycles.samples=32
scene.cycles.use_denoising=True
scene.render.resolution_x=960
scene.render.resolution_y=960
scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
bpy.ops.wm.save_as_mainfile(filepath=str(EDITABLE/'onerub-mechanical-office.blend'))
kwargs=dict(filepath=str(OUT/'onerub-mechanical-office.glb'),export_format='GLB',export_animations=True,export_frame_range=True,export_force_sampling=True,export_cameras=False,export_lights=False,export_apply=True)
props=bpy.ops.export_scene.gltf.get_rna_type().properties
if 'export_animation_mode' in props:kwargs['export_animation_mode']='SCENE'
bpy.ops.export_scene.gltf(**kwargs)
scene.render.filepath=str(OUT/'onerub-mechanical-office.png')
bpy.ops.render.render(write_still=True)
print('BLENDER_SCENE_COMPLETE: 50 segments; 10 tiers x 5 sides; bottom-to-top every 3 seconds; 30-second seamless cycle; all 500 step boundaries verified.')
