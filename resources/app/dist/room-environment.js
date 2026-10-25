import * as THREE from './vendor/three.module.min.js';

// These are small, entirely local scene assets. The room owns their geometry,
// materials and texture cache; changing pages never starts an animation loop.
const ENVIRONMENTS = {
  paper: { floor:'oak', wall:'plaster', shape:'arch', sky:['#a9c0bd','#f4d7a5'], trim:'#e0d6bf', pot:'#b78260', leaf:'#677a55', leafLight:'#8c9870', animal:'#b68661', animalKind:'cat', plant:'olive', object:'clock', day:true, light:'#ffe2a4', label:'胡桃木 · 午后日光' },
  glass: { floor:'terrazzo', wall:'limewash', shape:'rect', sky:['#b1cbd4','#edf2df'], trim:'#f5f7f3', pot:'#dbe2db', leaf:'#849d89', leafLight:'#b6c6ac', animal:'#c2ccc7', animalKind:'cat', plant:'eucalyptus', object:'vase', day:true, light:'#f6fff6', label:'纯白玻璃 · 晴窗柔光' },
  forest: { floor:'oak', wall:'timber', shape:'arch', sky:['#172c35','#617b72'], trim:'#59634e', pot:'#8e7960', leaf:'#7b9366', leafLight:'#a3b285', animal:'#a4a38a', animalKind:'bird', plant:'fern', object:'lantern', day:false, light:'#c5d9ef', label:'深木苔绿 · 林间月光' },
  hub: { floor:'parquet', wall:'brick', shape:'rect', sky:['#342f3b','#b97942'], trim:'#77654e', pot:'#a36e3c', leaf:'#7d8a62', leafLight:'#a7a56d', animal:'#625b50', animalKind:'cat', plant:'cactus', object:'lamp', day:false, light:'#ffcf88', label:'炭砖黄铜 · 都市暮色' },
  ex: { floor:'stone', wall:'linen', shape:'arch', sky:['#6a717d','#bab9ae'], trim:'#b8aa8c', pot:'#c3baa4', leaf:'#929782', leafLight:'#b6b89d', animal:'#c0b9aa', animalKind:'cat', plant:'olive', object:'vase', day:false, light:'#e7e1cf', label:'织纹石墨 · 静夜米金' },
  terminal: { floor:'tile', wall:'panel', shape:'rect', sky:['#233c35','#87ac88'], trim:'#6e8c73', pot:'#77856a', leaf:'#8eac76', leafLight:'#bed29d', animal:'#9cb778', animalKind:'frog', plant:'bonsai', object:'terrarium', day:true, light:'#d1efd0', label:'墨绿档案 · 雨后青光' },
  neon: { floor:'basalt', wall:'brushed', shape:'circle', sky:['#352c55','#84739f'], trim:'#ada1c1', pot:'#a091b7', leaf:'#839c9c', leafLight:'#b4c9bf', animal:'#c1b2d0', animalKind:'rabbit', plant:'succulent', object:'lamp', day:false, light:'#a9d8e5', label:'紫灰石面 · 星月冷光' },
  acid: { floor:'checker', wall:'plaster', shape:'arch', sky:['#d4babd','#e8daab'], trim:'#bac38d', pot:'#b36d91', leaf:'#909e52', leafLight:'#bbcd75', animal:'#d3a4b5', animalKind:'rabbit', plant:'cactus', object:'clock', day:true, light:'#f9e8af', label:'鼠尾草棋盘 · 花间暖阳' },
};

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = Math.imul(1664525, state) + 1013904223 >>> 0; return state / 4294967296; };
}

function tint(hex, other, amount) {
  return new THREE.Color(hex).lerp(new THREE.Color(other), amount).getStyle();
}

function texture(room, key, width, height, paint, repeat) {
  return room.staticTexture(`environment:${key}`, () => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    paint(canvas.getContext('2d'), width, height);
    const result = new THREE.CanvasTexture(canvas); result.colorSpace = THREE.SRGBColorSpace;
    if (repeat) { result.wrapS = result.wrapT = THREE.RepeatWrapping; result.repeat.set(...repeat); }
    result.anisotropy = Math.min(room.renderer?.capabilities.getMaxAnisotropy() || 1, room.qualityPreset?.anisotropy || 4);
    return result;
  });
}

function surfaceTexture(room, theme, config, palette, floor) {
  const kind = floor ? config.floor : config.wall, color = floor ? palette.floor : palette.wall;
  return texture(room, `${theme}:${floor ? 'floor' : 'wall'}`, 512, 512, (ctx, w, h) => {
    const rand = seeded(3127 + theme.length * 97 + (floor ? 19 : 43));
    ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
    // A bounded, deterministic grain produces tactile surfaces without images,
    // extra geometry, downloads or material changes while the camera moves.
    for (let i = 0; i < 4400; i++) {
      ctx.fillStyle = rand() > .5 ? 'rgba(255,255,255,.035)' : 'rgba(15,19,16,.035)';
      ctx.fillRect(rand() * w, rand() * h, rand() * 2 + .4, rand() * 2 + .4);
    }
    if (kind === 'oak' || kind === 'parquet') {
      const boards = kind === 'oak' ? 6 : 8, bh = h / boards;
      for (let row = 0; row < boards; row++) {
        ctx.fillStyle = row % 3 === 0 ? 'rgba(255,255,255,.035)' : 'rgba(15,13,9,.025)';
        ctx.fillRect(0, row * bh, w, bh);
        ctx.strokeStyle = 'rgba(22,18,12,.20)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(0, row * bh); ctx.lineTo(w, row * bh); ctx.stroke();
        const seam = (row % 2 ? .67 : .27) * w;
        ctx.beginPath(); ctx.moveTo(seam, row * bh); ctx.lineTo(seam, (row + 1) * bh); ctx.stroke();
        for (let line = 0; line < 24; line++) {
          const y = (row + rand()) * bh;
          ctx.strokeStyle = `rgba(${rand() > .5 ? '255,243,220' : '21,23,14'},${.035 + rand() * .04})`;
          ctx.lineWidth = .4 + rand() * .5; ctx.beginPath();
          for (let x = 0; x <= w; x += 16) {
            const yy = y + Math.sin(x * .013 + line) * 1.9;
            x ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
          }
          ctx.stroke();
        }
      }
    } else if (kind === 'terrazzo' || kind === 'basalt') {
      for (let i = 0; i < 850; i++) {
        const x = rand() * w, y = rand() * h, size = .5 + rand() * (kind === 'terrazzo' ? 3.7 : 2);
        ctx.fillStyle = tint(color, i % 3 === 0 ? '#98a99d' : i % 3 === 1 ? '#f8f3e8' : '#777e7e', kind === 'terrazzo' ? .22 : .12);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + size, y + size * .2); ctx.lineTo(x + size * .6, y + size); ctx.lineTo(x - size * .3, y + size * .7); ctx.fill();
      }
      if (kind === 'basalt') {
        ctx.strokeStyle = 'rgba(11,13,20,.20)'; ctx.lineWidth = 1;
        ctx.strokeRect(1, 1, w - 2, h - 2);
      }
    } else if (kind === 'checker' || kind === 'tile' || kind === 'stone') {
      const count = kind === 'checker' ? 6 : kind === 'tile' ? 4 : 2, cell = w / count;
      for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
        if (kind === 'checker') ctx.fillStyle = tint(color, (row + col) % 2 ? '#f1e9d7' : '#80956b', .22);
        else ctx.fillStyle = tint(color, rand() > .5 ? '#ffffff' : '#171b17', rand() * .035);
        ctx.fillRect(col * cell, row * cell, cell, cell);
        ctx.strokeStyle = kind === 'stone' ? 'rgba(15,16,19,.19)' : 'rgba(19,32,22,.13)'; ctx.lineWidth = kind === 'stone' ? 1.6 : .9;
        ctx.strokeRect(col * cell, row * cell, cell, cell);
      }
      if (kind === 'stone') for (let i = 0; i < 18; i++) {
        ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,.025)' : 'rgba(15,16,19,.027)'; ctx.lineWidth = .4;
        ctx.beginPath(); ctx.moveTo(rand() * w, 0); ctx.bezierCurveTo(rand() * w, h * .3, rand() * w, h * .7, rand() * w, h); ctx.stroke();
      }
    } else if (kind === 'brick') {
      const bh = 64, bw = 128;
      for (let row = 0; row < 8; row++) for (let col = -1; col < 5; col++) {
        const x = col * bw + (row % 2) * bw / 2;
        ctx.fillStyle = tint(color, rand() > .5 ? '#776958' : '#101217', rand() * .08);
        ctx.fillRect(x + 2, row * bh + 2, bw - 4, bh - 4);
        ctx.strokeStyle = 'rgba(12,10,9,.24)'; ctx.lineWidth = 2; ctx.strokeRect(x, row * bh, bw, bh);
      }
    } else if (kind === 'timber' || kind === 'panel' || kind === 'limewash' || kind === 'brushed') {
      const interval = kind === 'limewash' ? 128 : kind === 'panel' ? 42.67 : kind === 'timber' ? 64 : 32;
      for (let x = 0; x < w; x += interval) {
        const fade = ctx.createLinearGradient(x, 0, x + interval, 0);
        fade.addColorStop(0, `rgba(255,255,255,${kind === 'limewash' ? .10 : .025})`);
        fade.addColorStop(.8, 'rgba(255,255,255,0)'); fade.addColorStop(1, `rgba(9,15,12,${kind === 'panel' ? .24 : .055})`);
        ctx.fillStyle = fade; ctx.fillRect(x, 0, interval, h);
      }
      if (kind === 'timber') for (let i = 0; i < 90; i++) {
        ctx.strokeStyle = 'rgba(11,16,9,.035)'; ctx.beginPath();
        const x = rand() * w; ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 2, 130, x - 3, 360, x, h); ctx.stroke();
      }
    } else if (kind === 'linen') {
      ctx.lineWidth = .7;
      for (let n = 1; n < w; n += 4) {
        ctx.strokeStyle = 'rgba(255,249,224,.055)'; ctx.beginPath(); ctx.moveTo(n, 0); ctx.lineTo(n, h); ctx.stroke();
        ctx.strokeStyle = 'rgba(17,18,20,.06)'; ctx.beginPath(); ctx.moveTo(0, n); ctx.lineTo(w, n); ctx.stroke();
      }
    }
  }, floor ? [18, 18] : [25, 7.5]);
}

function skyTexture(room, theme, config, aspect) {
  const width = aspect > 1 ? 768 : Math.round(640 * aspect), height = aspect > 1 ? Math.round(768 / aspect) : 640;
  return texture(room, `${theme}:window:${aspect.toFixed(3)}`, width, height, (ctx, w, h) => {
    const rand = seeded(351 + theme.length), gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, config.sky[0]); gradient.addColorStop(1, config.sky[1]);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    const x = w * .66, y = h * (aspect > 2 ? .32 : .23), r = Math.min(w * (config.day ? .19 : .125), h * .27);
    const halo = ctx.createRadialGradient(x, y, r * .2, x, y, r * 2.4);
    halo.addColorStop(0, config.day ? 'rgba(255,245,200,.34)' : 'rgba(221,233,255,.20)'); halo.addColorStop(1, 'rgba(241,245,255,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = config.day ? '#fff1c7' : '#e3e5d6'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (!config.day) {
      // A crescent is part of the painted sky, not an emissive light on covers.
      ctx.fillStyle = tint(config.sky[0], config.sky[1], .23); ctx.beginPath(); ctx.arc(x + r * .49, y - r * .2, r * .87, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 25; i++) {
        ctx.fillStyle = `rgba(232,240,232,${.15 + rand() * .4})`; ctx.beginPath(); ctx.arc(rand() * w, rand() * h * .63, .6 + rand() * 1.2, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      ctx.fillStyle = 'rgba(255,255,245,.25)';
      for (const [cx, cy, rx] of [[.16, .24, .22], [.78, .50, .30]]) { ctx.beginPath(); ctx.ellipse(w * cx, h * cy, w * rx, h * .020, -.05, 0, Math.PI * 2); ctx.fill(); }
    }
    if (theme === 'hub' || theme === 'neon') {
      ctx.fillStyle = theme === 'hub' ? '#474043' : '#59516d';
      for (let i = 0; i < 14; i++) {
        const bw = 20 + rand() * 25, top = h * (.62 + rand() * .23), left = i * w / 12 - 10;
        ctx.fillRect(left, top, bw, h - top);
        ctx.fillStyle = theme === 'hub' ? 'rgba(249,200,117,.38)' : 'rgba(166,215,228,.35)';
        for (let yy = top + 12; yy < h; yy += 20) if (rand() > .33) ctx.fillRect(left + 7, yy, 4, 6);
        ctx.fillStyle = theme === 'hub' ? '#474043' : '#59516d';
      }
    } else {
      for (let layer = 0; layer < 3; layer++) {
        ctx.fillStyle = tint(config.sky[1], config.leaf, .3 + layer * .14); ctx.beginPath(); ctx.moveTo(0, h);
        for (let xx = 0; xx <= w + 20; xx += 20) ctx.lineTo(xx, h * (.70 + layer * .085) + Math.sin(xx * .016 + layer * 2) * h * .035);
        ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
      }
      if (theme === 'forest' || theme === 'terminal') for (let i = 0; i < 9; i++) {
        const tx = i * 57 - 20, top = h * (.48 + rand() * .16), width = 40 + rand() * 35;
        ctx.fillStyle = tint(config.leaf, '#203631', .52); ctx.beginPath(); ctx.moveTo(tx, top); ctx.lineTo(tx + width / 2, h * .91); ctx.lineTo(tx - width / 2, h * .91); ctx.closePath(); ctx.fill();
      }
    }
  });
}

function roundedShape(width, height, arch = false) {
  const x = -width / 2, y = -height / 2, top = arch ? width / 2 : .045, bottom = .025;
  const shape = new THREE.Shape();
  shape.moveTo(x + bottom, y); shape.lineTo(x + width - bottom, y); shape.quadraticCurveTo(x + width, y, x + width, y + bottom);
  shape.lineTo(x + width, y + height - top); shape.quadraticCurveTo(x + width, y + height, x + width - top, y + height);
  shape.lineTo(x + top, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - top);
  shape.lineTo(x, y + bottom); shape.quadraticCurveTo(x, y, x + bottom, y); shape.closePath();
  return shape;
}

function windowPaneGeometry(width, height, shape) {
  const geometry = shape === 'circle' ? new THREE.CircleGeometry(width / 2, 64) : new THREE.ShapeGeometry(roundedShape(width, height, shape === 'arch'), 24);
  const position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) uv.setXY(i, position.getX(i) / width + .5, position.getY(i) / height + .5);
  return geometry;
}

function addWindow(room, root, theme, config, material, layout, top) {
  const compact = layout === 'narrow';
  const width = compact ? 2.52 : config.shape === 'circle' ? 1.35 : 1.23;
  const height = compact ? .52 : config.shape === 'circle' ? 1.35 : 2.22;
  const shape = compact ? 'rect' : config.shape;
  const x = compact ? 0 : layout === 'single' ? .51 : -4.62;
  const y = compact ? top + .47 : config.shape === 'circle' ? 2.70 : 2.46;
  const group = new THREE.Group(); group.name = 'environment-window'; group.position.set(x, y, -.978); root.add(group);
  const frameMaterial = material(config.trim, { roughness: .55, metalness: theme === 'hub' || theme === 'ex' || theme === 'neon' ? .32 : .02 });
  const pane = new THREE.Mesh(room.geometry(`environment:window:${width}:${height}:${shape}`, () => windowPaneGeometry(width, height, shape)), new THREE.MeshBasicMaterial({ map:skyTexture(room, theme, config, width / height), toneMapped:false }));
  pane.position.z = .008; group.add(pane);
  let frame;
  if (shape === 'circle') {
    frame = new THREE.Mesh(room.geometry(`environment:ring:${width}`, () => new THREE.TorusGeometry(width / 2 + .027, .035, 10, 64)), frameMaterial);
  } else {
    const geometry = room.geometry(`environment:frame:${width}:${height}:${shape}`, () => {
      const frameShape = roundedShape(width + .14, height + .14, shape === 'arch'), hole = roundedShape(width, height, shape === 'arch');
      frameShape.holes.push(new THREE.Path(hole.getPoints(32).reverse()));
      return new THREE.ExtrudeGeometry(frameShape, { depth:.062, bevelEnabled:true, bevelSegments:1, steps:1, bevelSize:.006, bevelThickness:.005, curveSegments:24 });
    });
    frame = new THREE.Mesh(geometry, frameMaterial);
  }
  frame.position.z = .025; frame.castShadow = true; group.add(frame);
  if (shape !== 'circle') {
    room.box(group, .025, height - (shape === 'arch' ? .14 : .02), .036, frameMaterial, 0, shape === 'arch' ? -.06 : 0, .052, .004);
    if (!compact) {
      room.box(group, width, .027, .036, frameMaterial, 0, -.20, .052, .004);
      if (theme === 'glass' || theme === 'terminal') room.box(group, width, .027, .036, frameMaterial, 0, .43, .052, .004);
    }
  } else {
    room.box(group, width - .02, .022, .025, frameMaterial, 0, -.23, .055, .004);
  }
  if (!compact) room.box(group, width + .28, .062, .38, frameMaterial, 0, -height / 2 - .074, .144, .008);
  if (!compact && ['paper', 'glass', 'ex'].includes(theme)) {
    const cloth = material(tint(config.trim, '#ffffff', .26), { roughness:1, side:THREE.DoubleSide });
    for (const direction of [-1, 1]) {
      const geo = room.geometry('environment:curtain', () => {
        const geometry = new THREE.PlaneGeometry(.19, 2.3, 14, 3), pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.cos(pos.getX(i) * 130) * .027);
        geometry.computeVertexNormals(); return geometry;
      });
      const curtain = new THREE.Mesh(geo, cloth); curtain.position.set(direction * (width / 2 + .15), .025, .13); curtain.castShadow = true; group.add(curtain);
    }
    room.box(group, width + .6, .025, .03, frameMaterial, 0, height / 2 + .13, .13, .005);
  }
  if (!compact) addWindowLight(room, root, theme, config, x, y, width, height, layout);
  return { x, y, width, height, sillY:y - height / 2 - .043, sillZ:-.834 };
}

function addWindowLight(room, root, theme, config, x, y, width, height, layout) {
  const stamp = texture(room, `${theme}:light`, 256, 512, (ctx, w, h) => {
    const fade = ctx.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(255,255,255,.01)'); fade.addColorStop(.22, 'rgba(255,255,255,.64)'); fade.addColorStop(.76, 'rgba(255,255,255,.34)'); fade.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = fade;
    for (let row = 0; row < 3; row++) for (let col = 0; col < 2; col++) ctx.fillRect(15 + col * 120, 7 + row * 164, 106, 147);
  });
  const light = new THREE.Mesh(room.geometry('environment:light-plane', () => new THREE.PlaneGeometry(2.2, 3.15)), new THREE.MeshBasicMaterial({ map:stamp, color:config.light, transparent:true, opacity:config.day ? .23 : .12, depthWrite:false, toneMapped:false }));
  light.rotation.set(-Math.PI / 2, 0, -.36); light.position.set(layout === 'single' ? 1.05 : -3.63, .011, 1.40); light.renderOrder = 1; light.name = 'environment-window-light'; root.add(light);
  const glow = new THREE.PointLight(config.light, config.day ? .8 : .5, 3.1, 2); glow.position.set(x + .15, y, -.45); root.add(glow);
  const dustMap = texture(room, 'dust', 32, 32, (ctx, w, h) => {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(.25, 'rgba(255,255,255,.7)'); gradient.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  });
  const geometry = room.geometry(`environment:dust:${layout}:${config.shape}`, () => {
    const rand = seeded(527), points = [];
    for (let i = 0; i < 48; i++) points.push(x + (rand() - .5) * width * 1.28, y + (rand() - .5) * height * .95, -.70 + rand() * .24);
    const result = new THREE.BufferGeometry(); result.setAttribute('position', new THREE.Float32BufferAttribute(points, 3)); return result;
  });
  const dust = new THREE.Points(geometry, new THREE.PointsMaterial({ map:dustMap, color:config.light, size:2, sizeAttenuation:false, transparent:true, opacity:.32, depthWrite:false, toneMapped:false }));
  dust.name = 'environment-static-dust'; root.add(dust);
}

function primitives(room, material) {
  const sphereGeometry = room.geometry('environment:sphere', () => new THREE.SphereGeometry(1, 14, 10));
  const rodGeometry = room.geometry('environment:rod', () => new THREE.CylinderGeometry(1, 1, 1, 10));
  return {
    sphere(parent, color, x, y, z, sx, sy, sz, shadow = true) {
      const mesh = new THREE.Mesh(sphereGeometry, typeof color === 'string' ? material(color) : color);
      mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.castShadow = shadow; mesh.receiveShadow = true; parent.add(mesh); return mesh;
    },
    rod(parent, color, start, end, radius = .008) {
      const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end), mesh = new THREE.Mesh(rodGeometry, typeof color === 'string' ? material(color) : color);
      mesh.position.copy(a).add(b).multiplyScalar(.5); mesh.scale.set(radius, a.distanceTo(b), radius); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize()); mesh.castShadow = true; parent.add(mesh); return mesh;
    },
    ring(parent, radius, tube, color, x, y, z, horizontal = true) {
      const geometry = room.geometry(`environment:torus:${radius}:${tube}`, () => new THREE.TorusGeometry(radius, tube, 8, 32));
      const mesh = new THREE.Mesh(geometry, typeof color === 'string' ? material(color) : color); mesh.position.set(x, y, z); if (horizontal) mesh.rotation.x = Math.PI / 2; parent.add(mesh); return mesh;
    },
  };
}

function plant(room, parent, config, tools, material, x, y, z, scale = 1, variant = config.plant) {
  const group = new THREE.Group(); group.name = `environment-plant-${variant}`; group.position.set(x, y, z); group.scale.setScalar(scale); parent.add(group);
  const ceramic = material(config.pot, { roughness:.76 }), green = material(config.leaf, { roughness:.96 }), pale = material(config.leafLight, { roughness:1 });
  room.cylinder(group, .158, .117, .245, ceramic, 0, .123, 0, 24);
  tools.ring(group, .152, .011, ceramic, 0, .241, 0);
  room.cylinder(group, .14, .14, .008, material('#403e2b', { roughness:1 }), 0, .241, 0, 24);
  if (variant === 'cactus') {
    room.cylinder(group, .074, .077, .33, green, 0, .425, 0, 14); tools.sphere(group, green, 0, .59, 0, .074, .073, .074);
    for (const direction of [-1, 1]) {
      tools.rod(group, green, [0, .37 + direction * .04, 0], [direction * .13, .43 + direction * .04, 0], .038);
      tools.rod(group, green, [direction * .13, .43 + direction * .04, 0], [direction * .13, .55 + direction * .04, 0], .038);
      tools.sphere(group, green, direction * .13, .55 + direction * .04, 0, .038, .038, .038);
    }
    tools.sphere(group, config.pot, .01, .65, 0, .036, .022, .036, false);
  } else if (variant === 'succulent') {
    for (let i = 0; i < 10; i++) {
      const angle = i / 10 * Math.PI * 2, leaf = tools.sphere(group, i % 2 ? green : pale, Math.sin(angle) * .11, .30, Math.cos(angle) * .11, .052, .14, .03);
      leaf.rotation.set(Math.cos(angle) * .8, -angle, -Math.sin(angle) * .8);
    }
    tools.sphere(group, pale, 0, .36, 0, .057, .10, .045);
  } else if (variant === 'bonsai') {
    tools.rod(group, '#6b6748', [0, .24, 0], [.04, .51, -.015], .034);
    tools.rod(group, '#6b6748', [.04, .45, -.015], [-.13, .57, -.04], .021);
    for (const [xx, yy, zz, sx] of [[.07, .64, 0, .20], [-.15, .59, -.04, .16], [.21, .51, .015, .13]]) tools.sphere(group, green, xx, yy, zz, sx, .095, .14);
  } else {
    const fern = variant === 'fern', eucalyptus = variant === 'eucalyptus';
    for (let i = 0; i < (fern ? 7 : 5); i++) {
      const angle = i * 2.4, length = fern ? .45 : .43 + (i % 3) * .10;
      const dx = Math.sin(angle) * (fern ? .32 : .13), dz = Math.cos(angle) * .12, endY = .27 + length;
      tools.rod(group, config.leaf, [0, .24, 0], [dx, endY, dz], .006);
      for (let k = 0; k < 3; k++) {
        const along = .4 + k * .21, side = k % 2 ? -1 : 1;
        const leaf = tools.sphere(group, i % 2 ? green : pale, dx * along + side * .045, .24 + length * along, dz * along, eucalyptus ? .065 : fern ? .045 : .04, eucalyptus ? .071 : fern ? .15 : .089, .018, false);
        leaf.rotation.set(.2 + i * .23, i * .61, side * (fern ? 1 : .61));
      }
    }
  }
  return group;
}

function notebooks(room, parent, config, material, x, y, z, scale = 1) {
  const group = new THREE.Group(); group.name = 'environment-notebooks'; group.position.set(x, y, z); group.scale.setScalar(scale); group.rotation.y = -.13; parent.add(group);
  const paper = material('#dad6c7', { roughness:.98 });
  for (let i = 0; i < 2; i++) {
    const cover = material(i ? config.leaf : config.pot), offset = i * .043;
    room.box(group, .56, .058, .36, paper, offset, .044 + i * .086, 0, .004);
    room.box(group, .59, .012, .385, cover, offset, .009 + i * .086, 0, .003);
    room.box(group, .59, .012, .385, cover, offset, .079 + i * .086, 0, .003);
  }
  room.box(group, .018, .003, .25, material(config.trim), .17, .172, .075, 0);
}

function pencilCup(room, parent, config, tools, material, x, y, z) {
  const group = new THREE.Group(); group.name = 'environment-stationery'; group.position.set(x, y, z); parent.add(group);
  const cup = material(config.trim, { roughness:.52 });
  room.cylinder(group, .08, .071, .18, cup, 0, .09, 0, 24); tools.ring(group, .076, .006, cup, 0, .18, 0);
  room.cylinder(group, .068, .068, .003, material('#5b6657'), 0, .179, 0, 20);
  for (let i = 0; i < 4; i++) {
    const px = -.035 + i * .022, pz = i % 2 ? .02 : -.01, end = [px + (i - 1.5) * .018, .34 + (i % 2) * .025, pz];
    tools.rod(group, i % 2 ? config.pot : config.leaf, [px, .08, pz], end, .009);
    room.cylinder(group, 0, .009, .035, material('#c9b68d'), end[0], end[1] + .016, end[2], 6);
  }
}

function desktopObject(room, parent, theme, config, tools, material, x, y, z) {
  const group = new THREE.Group(); group.name = `environment-${config.object}`; group.position.set(x, y, z); parent.add(group);
  if (config.object === 'clock') {
    const map = texture(room, `${theme}:clock`, 192, 192, (ctx, w, h) => {
      ctx.fillStyle = '#eee8d8'; ctx.fillRect(0, 0, w, h); ctx.translate(w / 2, h / 2);
      ctx.strokeStyle = config.trim; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(0, 0, 87, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#646451'; ctx.lineWidth = 3;
      for (let i = 0; i < 12; i++) { const a = i / 6 * Math.PI; ctx.beginPath(); ctx.moveTo(Math.sin(a) * 69, Math.cos(a) * 69); ctx.lineTo(Math.sin(a) * 77, Math.cos(a) * 77); ctx.stroke(); }
      ctx.lineCap = 'round'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-29, -26); ctx.lineTo(0, 0); ctx.lineTo(39, -37); ctx.stroke();
    });
    const rim = material(config.trim, { roughness:.42, metalness:.15 });
    const casing = room.cylinder(group, .203, .203, .065, rim, 0, .235, -.008, 48); casing.rotation.x = Math.PI / 2;
    const face = new THREE.Mesh(room.geometry('environment:clock-face', () => new THREE.CircleGeometry(.187, 48)), new THREE.MeshBasicMaterial({ map, toneMapped:true })); face.position.set(0, .235, .028); group.add(face);
    for (const dx of [-.12, .12]) room.box(group, .043, .09, .12, rim, dx, .046, 0, .01);
  } else if (config.object === 'vase') {
    const ceramic = material(config.trim, { roughness:theme === 'glass' ? .31 : .83 });
    tools.sphere(group, ceramic, 0, .18, 0, .13, .18, .12); room.cylinder(group, .045, .068, .12, ceramic, 0, .35, 0, 24);
    for (const direction of [-1, 1]) {
      tools.rod(group, config.leaf, [0, .38, 0], [direction * .10, .69 - direction * .03, 0], .004);
      tools.sphere(group, config.leafLight, direction * .07, .56, 0, .04, .085, .015, false).rotation.z = direction * .5;
    }
  } else if (config.object === 'terrarium') {
    const metal = material(config.trim, { roughness:.6, metalness:.25 });
    room.box(group, .35, .045, .26, metal, 0, .025, 0, .015);
    for (const xx of [-.16, .16]) for (const zz of [-.11, .11]) tools.rod(group, metal, [xx, .05, zz], [xx, .37, zz], .008);
    for (const xx of [-.16, .16]) tools.rod(group, metal, [xx, .37, -.11], [xx, .37, .11], .007);
    for (const zz of [-.11, .11]) tools.rod(group, metal, [-.16, .37, zz], [.16, .37, zz], .007);
    const pane = new THREE.Mesh(room.geometry('environment:terrarium-glass', () => new THREE.BoxGeometry(.316, .31, .216)), material('#cbdac9', { transparent:true, opacity:.10, roughness:.16, depthWrite:false })); pane.position.y = .205; group.add(pane);
    for (let i = 0; i < 3; i++) tools.sphere(group, i % 2 ? config.leaf : config.leafLight, (i - 1) * .079, .105 + (i % 2) * .04, 0, .065, .073, .061);
  } else {
    const metal = material(config.trim, { metalness:.42, roughness:.48 });
    room.cylinder(group, .12, .14, .028, metal, 0, .014, 0, 28);
    room.cylinder(group, .012, .016, .26, metal, 0, .158, 0, 12);
    const shade = material(config.object === 'lantern' ? '#ddd2a8' : config.pot, { roughness:.7, side:THREE.DoubleSide, emissive:new THREE.Color(config.light), emissiveIntensity:.17 });
    const geometry = room.geometry(`environment:lamp:${config.object}`, () => new THREE.CylinderGeometry(config.object === 'lantern' ? .15 : .105, .20, .22, 32, 1, true));
    const mesh = new THREE.Mesh(geometry, shade); mesh.position.y = .39; mesh.castShadow = true; group.add(mesh);
    tools.ring(group, .20, .006, metal, 0, .28, 0);
    if (config.object === 'lantern') tools.ring(group, .09, .007, metal, 0, .60, 0, false);
    const glow = new THREE.PointLight(config.light, .6, 1.65, 2); glow.position.set(0, .28, .015); group.add(glow);
  }
}

function animal(room, parent, config, tools, material, x, y, z, scale = 1) {
  const group = new THREE.Group(); group.name = `environment-${config.animalKind}`; group.position.set(x, y, z); group.scale.setScalar(scale); group.rotation.y = -.22; parent.add(group);
  const fur = material(config.animal, { roughness:.94 }), dark = material('#474a42', { roughness:1 });
  if (config.animalKind === 'bird') {
    tools.sphere(group, fur, 0, .18, 0, .12, .15, .12); tools.sphere(group, fur, .01, .32, .04, .093, .094, .084);
    tools.sphere(group, config.leaf, -.08, .20, -.026, .057, .12, .075);
    const beak = room.cylinder(group, 0, .022, .06, material(config.pot), .03, .32, .14, 6); beak.rotation.x = Math.PI / 2;
    tools.sphere(group, dark, .060, .337, .104, .008, .008, .006, false);
    for (const xx of [-.045, .045]) tools.rod(group, config.trim, [xx, .02, .02], [xx, .075, 0], .008);
  } else if (config.animalKind === 'frog') {
    tools.sphere(group, fur, 0, .13, 0, .18, .12, .14);
    for (const xx of [-.12, .12]) {
      tools.sphere(group, fur, xx, .059, .085, .091, .039, .084);
      tools.sphere(group, config.leafLight, xx * .65, .23, .064, .052, .057, .048);
      tools.sphere(group, dark, xx * .65, .239, .107, .013, .017, .008, false);
    }
  } else if (config.animalKind === 'rabbit') {
    tools.sphere(group, fur, -.04, .20, 0, .22, .20, .175); tools.sphere(group, fur, .17, .31, .02, .131, .13, .12);
    for (const xx of [.115, .207]) {
      const ear = tools.sphere(group, fur, xx, .50, .005, .035, .15, .030); ear.rotation.z = -.10;
      const inner = tools.sphere(group, tint(config.animal, config.pot, .25), xx, .50, .032, .014, .10, .006, false); inner.rotation.z = -.10;
    }
    tools.sphere(group, dark, .207, .327, .13, .011, .011, .007, false);
    tools.sphere(group, config.trim, -.27, .19, -.005, .08, .076, .07);
    tools.sphere(group, fur, .12, .065, .10, .12, .06, .095);
  } else {
    tools.sphere(group, fur, -.04, .15, 0, .30, .146, .22); tools.sphere(group, fur, .235, .18, .075, .14, .12, .125);
    for (const xx of [.17, .30]) {
      const ear = room.cylinder(group, 0, .065, .112, fur, xx, .303, .06, 3); ear.rotation.y = Math.PI / 4;
    }
    const geometry = room.geometry('environment:cat-tail', () => new THREE.TorusGeometry(.233, .047, 8, 30, Math.PI * 1.27));
    const tail = new THREE.Mesh(geometry, fur); tail.rotation.set(Math.PI / 2, 0, .7); tail.position.set(-.09, .111, .008); tail.castShadow = true; group.add(tail);
    for (const xx of [.188, .279]) tools.rod(group, dark, [xx - .022, .191, .192], [xx + .012, .183, .194], .004);
    tools.sphere(group, config.pot, .242, .163, .202, .018, .013, .008, false);
  }
  return group;
}

/**
 * Build after cabinets and the optional reading corner. Passing the existing
 * floor and wall replaces their materials; omit them to use the returned ones.
 * No event listeners, timers, RAF callbacks, external assets or book metadata.
 */
export function createRoomEnvironment(room, { layout = 'double', rows = 2, floor, wall } = {}) {
  const theme = ENVIRONMENTS[room.theme] ? room.theme : 'paper', config = ENVIRONMENTS[theme], palette = room.palette;
  const root = new THREE.Group(); root.name = 'room-environment'; root.userData = { theme, layout, static:true }; room.world.add(root);
  const materialCache = new Map();
  const material = (color, options = {}) => {
    const key = JSON.stringify([color, options]);
    if (!materialCache.has(key)) materialCache.set(key, room.material(color, options));
    return materialCache.get(key);
  };
  const tools = primitives(room, material), compact = layout === 'narrow', top = rows * 1.55 + .3975;
  const floorMap = surfaceTexture(room, theme, config, palette, true), wallMap = surfaceTexture(room, theme, config, palette, false);
  const floorMaterial = room.material('#ffffff', { map:floorMap, roughness:theme === 'glass' ? .67 : theme === 'neon' ? .72 : .9 });
  const wallMaterial = room.material('#ffffff', { map:wallMap, roughness:1 });
  for (const [mesh, next] of [[floor, floorMaterial], [wall, wallMaterial]]) if (mesh) { mesh.material.dispose(); mesh.material = next; }
  room.box(root, 24, .15, .036, material(tint(palette.wall, config.trim, .13)), 0, .078, -1.007, .004);
  const window = addWindow(room, root, theme, config, material, layout, top);
  if (compact) {
    plant(room, root, config, tools, material, -1.20, top, -.04, .63);
    notebooks(room, root, config, material, .70, top, .01, .76);
    pencilCup(room, root, config, tools, material, 1.25, top, -.01);
    animal(room, root, config, tools, material, -.18, top, .10, .58);
  } else {
    const left = layout === 'single' ? -1.95 : -2.04;
    plant(room, root, config, tools, material, left - 1.01, top, -.08, .93);
    desktopObject(room, root, theme, config, tools, material, left + .06, top, -.04);
    notebooks(room, root, config, material, left + 1.08, top, .02, 1);
    pencilCup(room, root, config, tools, material, left + 1.41, top, -.20);
    if (layout === 'double') {
      notebooks(room, root, config, material, 1.02, top, -.04, .93);
      desktopObject(room, root, theme, { ...config, object:['paper', 'glass', 'acid'].includes(theme) ? 'vase' : 'lamp' }, tools, material, 2.12, top, -.04);
      plant(room, root, config, tools, material, 3.12, top, -.09, .70, theme === 'glass' || theme === 'neon' ? 'succulent' : 'bonsai');
      if (config.animalKind === 'bird') animal(room, root, config, tools, material, 3.49, top, .12, .77);
    }
    const plantX = layout === 'double' ? 4.38 : 4.03;
    plant(room, root, config, tools, material, plantX, 0, -.24, 1.85, theme === 'neon' ? 'eucalyptus' : config.plant);
    // Perching on the sill keeps companions above the bottom control bar at all
    // supported viewport heights. Background props also remain behind books.
    if (config.animalKind !== 'bird' || layout === 'single') animal(room, root, config, tools, material, window.x - .13, window.sillY, window.sillZ, config.animalKind === 'frog' ? 1 : .82);
  }
  const bounds = compact ? { width:4.92, height:rows * 1.55 + 1.5, targetY:rows * 1.55 / 2 + .5, targetX:0 }
    : { width:layout === 'double' ? 10.8 : 9.8, height:5.3, targetY:2.0, targetX:layout === 'double' ? -.10 : .10 };
  const setQuality = preset => root.traverse(object => { if(object.isPoints)object.visible=preset.dust!==false; });
  setQuality(room.qualityPreset || {});
  return { group:root, floorMaterial, wallMaterial, bounds, label:config.label, setQuality };
}
