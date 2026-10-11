import { Color, Mesh, PlaneGeometry, ShaderMaterial, Vector4 } from 'three';
import type { ResolvedQuality } from './palette';

export const WATER_LEVEL = -1.02;
export const SPLASH_LIMIT = 8;

const vertex = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const fragment = /* glsl */`
  uniform float uTime;
  uniform float uRadius;
  uniform float uFull;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uFoam;
  uniform vec4 uSplashes[8];
  varying vec3 vWorld;
  void main() {
    vec2 p = vWorld.xz;
    float t = uTime;
    float a = dot(p, vec2(0.73, 0.41)) + t * 0.45;
    float b = dot(p, vec2(-0.38, 0.81)) - t * 0.33;
    float c = dot(p, vec2(1.15, -0.67)) + t * 0.24;
    float swell = sin(a) * 0.52 + sin(b) * 0.32 + sin(c) * 0.16;
    vec2 slope = cos(a) * vec2(0.073, 0.041) + cos(b) * vec2(-0.0304, 0.0648) + cos(c) * vec2(0.0345, -0.0201);
    vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 view = normalize(cameraPosition - vWorld);
    float fresnel = pow(1.0 - max(dot(normal, view), 0.0), 3.0);
    float distanceToBoard = length(p);
    float shallow = 1.0 - smoothstep(uRadius + 1.5, uRadius + 14.0, distanceToBoard);
    vec3 color = mix(uDeep, uShallow, 0.22 + shallow * 0.48 + swell * 0.07);
    color = mix(color, vec3(0.48, 0.8, 0.84), fresnel * 0.32);

    // Moving caustic ribbons, no reflection buffer or post-processing pass.
    float ribbons = abs(sin(a * 2.7 + sin(b * 1.6) * 0.9) + sin(b * 2.4 + sin(c) * 0.7));
    float caustic = 1.0 - smoothstep(0.025, 0.15, ribbons);
    color += vec3(0.05, 0.13, 0.11) * caustic * (0.35 + 0.65 * shallow);
    #if HIGH_WATER == 1
      float fine = abs(sin(c * 2.2 + sin(a)) + sin(a * 1.7 - sin(b)));
      color += vec3(0.035, 0.09, 0.07) * (1.0 - smoothstep(0.01, 0.065, fine)) * 0.45;
    #endif

    vec3 halfLight = normalize(normalize(vec3(-0.45, 0.9, -0.3)) + view);
    float sunlight = pow(max(dot(normal, halfLight), 0.0), 110.0);
    color += vec3(1.0, 0.9, 0.67) * sunlight * 0.36;

    // Ground the floating pontoon with a soft contact shadow and a breathing foam edge.
    float shadow = 1.0 - smoothstep(uRadius + 0.15, uRadius + 1.8, length(p - vec2(0.45, -0.55)));
    color *= 1.0 - shadow * 0.34;
    float angle = atan(p.y, p.x);
    float edge = uRadius + 0.83 + sin(angle * 8.0 + t * 0.8) * 0.07;
    float foam = (1.0 - smoothstep(0.045, 0.2, abs(distanceToBoard - edge))) * 0.46;
    float wake = (1.0 - smoothstep(0.025, 0.075, abs(distanceToBoard - edge - 0.52 - sin(angle * 5.0 - t * 0.5) * 0.12))) * 0.17;
    color = mix(color, uFoam, (foam + wake) * (0.65 + sin(angle * 11.0 + t * 0.3) * 0.25));

    // A fixed pool of ring-out ripples, recycled rather than allocating meshes per knockout.
    for (int i = 0; i < 8; i++) {
      vec4 splash = uSplashes[i];
      float age = t - splash.z;
      if (splash.w > 0.0 && age >= 0.0 && age < 2.0) {
        float d = length(p - splash.xy);
        float progress = age / 2.0;
        float r = 0.15 + age * 2.2;
        float ring = 1.0 - smoothstep(0.035, 0.12, abs(d - r));
        float inner = 1.0 - smoothstep(0.025, 0.07, abs(d - r * 0.65));
        color = mix(color, uFoam, (ring + inner * 0.35) * (1.0 - progress) * splash.w * 0.8);
      }
    }
    float alpha = mix(1.0 - smoothstep(uRadius + 5.0, uRadius + 15.0, distanceToBoard), 1.0, uFull);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }`;

/** One flat mesh. All animation is in the material, and stops under reduced motion. */
export class LagoonWater {
  readonly material: ShaderMaterial;
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  private clock = 0;
  private cursor = 0;
  private readonly splashes = Array.from({ length: SPLASH_LIMIT }, () => new Vector4(0, 0, 0, 0));

  constructor(radius: number, quality: ResolvedQuality) {
    this.material = new ShaderMaterial({
      vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false, toneMapped: false,
      defines: { HIGH_WATER: quality === 'high' ? 1 : 0 },
      uniforms: {
        uTime: { value: 0 }, uRadius: { value: radius }, uFull: { value: 0 },
        uDeep: { value: new Color('#148ca8') }, uShallow: { value: new Color('#42c7c5') },
        uFoam: { value: new Color('#d8fff2') }, uSplashes: { value: this.splashes },
      },
    });
    const geometry = new PlaneGeometry(220, 220);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.position.y = WATER_LEVEL;
    this.mesh.name = 'lagoon-water';
    this.mesh.renderOrder = -20;
    this.mesh.frustumCulled = false;
  }

  setMatchView(active: boolean): void { this.material.uniforms.uFull.value = active ? 1 : 0; }

  splash(x: number, z: number, reducedMotion: boolean): void {
    if (reducedMotion || !Number.isFinite(x) || !Number.isFinite(z)) return;
    this.splashes[this.cursor].set(x, z, this.clock, 1);
    this.cursor = (this.cursor + 1) % SPLASH_LIMIT;
  }

  update(dt: number, reducedMotion: boolean): void {
    if (reducedMotion) { for (const splash of this.splashes) splash.w = 0; return; }
    this.clock += Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    this.material.uniforms.uTime.value = this.clock;
  }

  clear(): void { for (const splash of this.splashes) splash.w = 0; }
}
