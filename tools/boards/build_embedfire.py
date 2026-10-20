# SPDX-License-Identifier: MIT
"""Build the illustrative 野火 K210 CAM model and render top/angled views.

Run:  Blender --background --python tools/boards/build_embedfire.py
Outputs (relative to the repo root, override with --out/--renders after `--`):
  tools/boards/models/embedfire-cam.blend
  tools/boards/models/embedfire-cam.glb
  desktop/scope-extension/resources/boards/embedfire-cam-top.png
  desktop/scope-extension/resources/boards/embedfire-cam-angled.png

The model is a teaching illustration, not mechanical CAD: relative component
placement follows the vendor reference photo, but dimensions, PCB revision and
per-contact orientation are not verified. See tools/boards/README.md.
"""
import math
import os
import sys

import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def parse_args():
    out_dir = os.path.join(REPO, 'tools', 'boards', 'models')
    render_dir = os.path.join(REPO, 'desktop', 'scope-extension', 'resources', 'boards')
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    for index, value in enumerate(argv):
        if value == '--out' and index + 1 < len(argv):
            out_dir = os.path.abspath(argv[index + 1])
        elif value == '--renders' and index + 1 < len(argv):
            render_dir = os.path.abspath(argv[index + 1])
    return out_dir, render_dir


def collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def move_to_collection(obj, coll):
    for old in obj.users_collection:
        old.objects.unlink(obj)
    coll.objects.link(obj)


def material(name, color, metallic=0.0, roughness=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


def box(name, size, location, mat, coll, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = obj.modifiers.new('edge', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
    obj.data.materials.append(mat)
    move_to_collection(obj, coll)
    return obj


def cylinder(name, radius, depth, location, mat, coll, vertices=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    move_to_collection(obj, coll)
    return obj


def build(coll, mats):
    board = box('pcb', (9.0, 6.0, 0.14), (0, 0, 0), mats['pcb'], coll, bevel=0.18)
    # Four silver mounting holes.
    for index, (x, y) in enumerate([(-4.05, 2.55), (4.05, 2.55), (-4.05, -2.55), (4.05, -2.55)]):
        cylinder(f'hole-{index + 1}', 0.28, 0.16, (x, y, 0.02), mats['silver'], coll)
        cylinder(f'hole-{index + 1}-inner', 0.13, 0.2, (x, y, 0.02), mats['dark'], coll)

    # K210 processor: dark QFN with a faint metal lid, upper-left.
    box('processor', (1.5, 1.5, 0.12), (-2.6, 2.0, 0.13), mats['chip'], coll, bevel=0.05)
    box('processor-mark', (0.5, 0.5, 0.13), (-2.6, 2.0, 0.14), mats['dark'], coll, bevel=0.04)

    # Camera module upper-middle/right: small PCB + lens + orange flex ribbon.
    box('camera', (1.6, 1.4, 0.1), (0.6, 2.1, 0.12), mats['chip'], coll, bevel=0.04)
    lens = cylinder('camera-lens', 0.42, 0.3, (0.6, 2.15, 0.3), mats['dark'], coll)
    cylinder('camera-glass', 0.3, 0.05, (0.6, 2.15, 0.47), mats['lens'], coll)
    box('camera-ribbon', (0.7, 1.1, 0.03), (0.6, 1.25, 0.09), mats['flex'], coll)

    # microSD slot, top-right area but clear of the relocated top-edge buttons.
    box('sd', (1.3, 1.3, 0.18), (2.9, 1.25, 0.16), mats['silver'], coll, bevel=0.08)
    box('sd-slot', (1.3, 0.25, 0.1), (2.9, 0.67, 0.14), mats['dark'], coll)

    # USB connector protruding on the right edge.
    box('usb', (1.2, 1.5, 0.6), (4.4, 0.6, 0.32), mats['silver'], coll, bevel=0.1)
    box('usb-tongue', (0.9, 1.0, 0.25), (4.55, 0.6, 0.32), mats['dark'], coll)

    def socket(name, x, y):
        # Female header sockets, matching the vendor photo: a gold rim flush
        # with the housing top around a dark inset hole, not protruding pins.
        cylinder(f'{name}-rim-{x}-{y}', 0.105, 0.05, (x, y, 0.3), mats['gold'], coll)
        cylinder(f'{name}-hole-{x}-{y}', 0.055, 0.07, (x, y, 0.3), mats['dark'], coll)

    # 2x14 pin header, bottom center-left (3.3V bank in the vendor table).
    box('header-1', (4.4, 0.75, 0.22), (-1.6, -2.35, 0.18), mats['plastic'], coll, bevel=0.03)
    for row in range(2):
        for column in range(14):
            socket('header-1', -3.55 + column * 0.3, -2.5 + row * 0.3)

    # 2x3 pin header, bottom-right (1.8V bank in the vendor table).
    box('header-2', (1.05, 0.75, 0.22), (2.6, -2.35, 0.18), mats['plastic'], coll, bevel=0.03)
    for row in range(2):
        for column in range(3):
            socket('header-2', 2.3 + column * 0.3, -2.5 + row * 0.3)

    # Screen ribbon socket on the left edge + short orange flex.
    box('lcd-socket', (0.6, 2.6, 0.25), (-4.15, 0.4, 0.2), mats['plastic'], coll, bevel=0.05)
    box('lcd-ribbon', (0.8, 2.2, 0.03), (-3.6, 0.4, 0.1), mats['flex'], coll)

    # Horizontal ribbon socket, lower-middle.
    box('fpc', (2.2, 0.6, 0.25), (0.2, -1.2, 0.2), mats['plastic'], coll, bevel=0.05)
    box('fpc-ribbon', (1.9, 0.7, 0.03), (0.2, -1.75, 0.1), mats['flex'], coll)

    # Two buttons on the top edge, upper-right as in the vendor photo.
    for index, x in enumerate([1.2, 2.3]):
        box(f'button-{index + 1}', (0.35, 0.3, 0.18), (x, 2.85, 0.16), mats['silver'], coll, bevel=0.05)
        cylinder(f'button-{index + 1}-cap', 0.09, 0.22, (x, 2.85, 0.2), mats['dark'], coll)

    # Sparse silkscreen markings (decorative ticks only; no pin numbering).
    for x in [-3.0, -1.5, 0.0, 1.5, 3.0]:
        box(f'silk-{x}', (0.5, 0.06, 0.01), (x, -1.85, 0.08), mats['silk'], coll)

    return board


def top_camera():
    bpy.ops.object.camera_add(location=(0, 0, 14))
    cam = bpy.context.object
    cam.name = 'camera-top'
    cam.data.type = 'ORTHO'
    # ortho_scale is the horizontal span: 10.8 x 8.1 board units over 960x720,
    # which matches the % hotspot coordinates in nodu-board-widget.tsx.
    cam.data.ortho_scale = 10.8
    cam.rotation_euler = (0, 0, 0)
    return cam


def angled_camera():
    bpy.ops.object.camera_add(location=(7.5, -9.5, 11))
    cam = bpy.context.object
    cam.name = 'camera-angled'
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 12.0
    direction = -cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    return cam


def render(scene, camera, path):
    scene.camera = camera
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    out_dir, render_dir = parse_args()
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(render_dir, exist_ok=True)

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for datablocks in (bpy.data.cameras, bpy.data.materials):
        for datablock in list(datablocks):
            datablocks.remove(datablock)

    scene = bpy.context.scene
    # Cycles is used because EEVEE does not honour film_transparent on this
    # setup (Blender 5.2 renders an opaque backdrop); Cycles output is
    # deterministic enough for these simple shaded primitives.
    for engine in ('CYCLES', 'BLENDER_WORKBENCH'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    if scene.render.engine == 'CYCLES':
        scene.cycles.samples = 64
        scene.cycles.use_denoising = True
        scene.cycles.max_bounces = 4
    scene.render.resolution_x = 960
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    scene.render.image_settings.color_depth = '8'

    mats = {
        'pcb': material('pcb-black', (0.015, 0.016, 0.018), roughness=0.55),
        'chip': material('chip', (0.05, 0.05, 0.055), roughness=0.4),
        'plastic': material('connector-plastic', (0.02, 0.02, 0.022), roughness=0.6),
        'silver': material('metal', (0.62, 0.64, 0.68), metallic=0.85, roughness=0.35),
        'gold': material('gold-contact', (0.72, 0.55, 0.2), metallic=0.9, roughness=0.3),
        'flex': material('flex-orange', (0.75, 0.32, 0.08), roughness=0.5),
        'dark': material('dark-inset', (0.008, 0.008, 0.01), roughness=0.3),
        'lens': material('lens-glass', (0.1, 0.14, 0.2), metallic=0.6, roughness=0.1),
        'silk': material('silkscreen', (0.75, 0.75, 0.72), roughness=0.8),
    }

    coll = collection('embedfire-cam')
    build(coll, mats)

    bpy.ops.object.light_add(type='AREA', location=(0, -2, 12))
    key = bpy.context.object
    key.name = 'key-light'
    key.data.energy = 900
    key.data.shape = 'DISK'
    key.data.size = 6
    bpy.ops.object.light_add(type='AREA', location=(-6, 5, 6))
    fill = bpy.context.object
    fill.name = 'fill-light'
    fill.data.energy = 400
    fill.data.size = 5
    world = bpy.data.worlds.new('studio') if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.05, 0.06, 1.0)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6

    top = top_camera()
    render(scene, top, os.path.join(render_dir, 'embedfire-cam-top.png'))
    angled = angled_camera()
    render(scene, angled, os.path.join(render_dir, 'embedfire-cam-angled.png'))

    # Keep the repo clean: no .blend1 backup alongside the committed file.
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, 'embedfire-cam.blend'))
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, 'embedfire-cam.glb'),
                              export_format='GLB', export_cameras=False)
    print('NODU_BOARD_MODEL_DONE', out_dir, render_dir)


main()
