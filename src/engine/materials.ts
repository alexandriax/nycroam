import * as THREE from 'three';
import { quality } from './quality';
import {
  MATERIAL_ATLAS_GLSL,
  MATERIAL_TIER_CONTRACTS,
  SURFACE_REGION,
  materialLibrary,
} from './materialLibrary';
import { facadeDetailLod } from './facadeLod';

interface FacadeDetailFadeUniforms {
  start: THREE.IUniform<number>;
  end: THREE.IUniform<number>;
}

/** Keep the shared facade shader in lockstep with the current streaming ring. */
export function setFacadeDetailFade(
  material: THREE.Material,
  loadRadius: number,
): void {
  const uniforms = material.userData.nycFacadeDetailFade as
    | FacadeDetailFadeUniforms
    | undefined;
  if (!uniforms) return;
  const lod = facadeDetailLod(loadRadius);
  uniforms.start.value = lod.fadeStart;
  uniforms.end.value = lod.fadeEnd;
}

/**
 * Far facades are intentionally neutral massing. At this angular size windows
 * are sub-pixel; inventing a reflective whole-building response both washes out
 * the skyline and creates a visible brightness pop when the detailed tile
 * arrives. Close/mid tiles supply the real pane response.
 */
export function makeFacadeLodMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  mat.dithering = true;
  mat.userData.nycMaterialSurface = 'semantic-facade-lod';
  mat.userData.nycMaterialChannels = [];
  mat.userData.nycNeutralFarMassing = true;
  return mat;
}

/**
 * Facade material: Lambert + procedural window grid on vertical faces.
 * Windows are carved in the fragment shader from world position; brick/roof
 * normals are world-projected so close surfaces carry real light relief without
 * extra geometry. Screen-space filtering keeps the grid stable in motion, and
 * expensive detail fades before it becomes sub-pixel. Still one material and
 * one draw call per tile.
 */
export function makeFacadeMaterial(): THREE.MeshLambertMaterial {
  // DoubleSide + front-facing test: if imperfect OSM data leaves any opening,
  // the inside of the far wall renders as a dark interior instead of void.
  const q = quality();
  // Keep the city-scale facade batch on Lambert: the procedural window shader
  // supplies the reflection cues, while applying the full Standard BRDF to
  // every visible building is a poor mobile/desktop trade at this scale.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.dithering = true;
  // Normal-map relief is the premium desktop close-up path. Mobile keeps the
  // anti-aliased windows/reflections but avoids a second texture sample before
  // lighting; its lower resolution makes the micro-relief imperceptible anyway.
  const materialContract = MATERIAL_TIER_CONTRACTS[q.level];
  const premiumSurfaceNormals = materialContract.facadeNormals;
  const surfaceOrm = materialContract.ormAtlas;
  mat.userData.nycMaterialSurface = 'semantic-facade-roof';
  mat.userData.nycMaterialChannels = [
    'color',
    ...(premiumSurfaceNormals ? ['normal'] : []),
    ...(surfaceOrm ? ['orm'] : []),
  ];
  mat.userData.nycSolidReflectiveGlass = true;
  mat.userData.nycStablePaneReflection = true;
  const authoredLod = facadeDetailLod(q.loadRadius);
  const detailFade: FacadeDetailFadeUniforms = {
    start: { value: authoredLod.fadeStart },
    end: { value: authoredLod.fadeEnd },
  };
  mat.userData.nycFacadeDetailFade = detailFade;
  mat.customProgramCacheKey = () => `nyc-semantic-facade-${premiumSurfaceNormals ? 'n' : 'x'}-${surfaceOrm ? 'o' : 'x'}-v6`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNycSurfaceColor = materialLibrary.colorUniform;
    shader.uniforms.uNycFacadeFadeStart = detailFade.start;
    shader.uniforms.uNycFacadeFadeEnd = detailFade.end;
    if (premiumSurfaceNormals) shader.uniforms.uNycSurfaceNormal = materialLibrary.normalUniform;
    if (surfaceOrm) shader.uniforms.uNycSurfaceOrm = materialLibrary.ormUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aStyle;
        attribute float aSemantic;
        attribute vec4 aFacade;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vStyle;
        varying float vSemantic;
        varying vec4 vFacade;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);
        vStyle = aStyle;
        vSemantic = aSemantic;
        vFacade = aFacade;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying float vStyle;
        varying float vSemantic;
        varying vec4 vFacade;
        vec3 nycMasonryNormal = vec3(0.0, 1.0, 0.0);
        float nycMasonryWeight = 0.0;
        uniform sampler2D uNycSurfaceColor;
        uniform float uNycFacadeFadeStart;
        uniform float uNycFacadeFadeEnd;
        ${premiumSurfaceNormals ? 'uniform sampler2D uNycSurfaceNormal;' : ''}
        ${surfaceOrm ? 'uniform sampler2D uNycSurfaceOrm;' : ''}
        ${MATERIAL_ATLAS_GLSL}
        float nycFacadeRegion(float styleId) {
          if (abs(styleId - 5.0) < 0.5 || abs(styleId - 14.0) < 0.5) return ${SURFACE_REGION.brickBrown.toFixed(1)};
          if (abs(styleId - 2.0) < 0.5 || abs(styleId - 10.0) < 0.5 || abs(styleId - 12.0) < 0.5) return ${SURFACE_REGION.limestone.toFixed(1)};
          if (abs(styleId - 8.0) < 0.5) return ${SURFACE_REGION.paintedCastIron.toFixed(1)};
          if (abs(styleId - 3.0) < 0.5 || abs(styleId - 9.0) < 0.5) return ${SURFACE_REGION.concreteAged.toFixed(1)};
          return ${SURFACE_REGION.brickRed.toFixed(1)};
        }
        float nycRoofRegion(float semantic) {
          float roofFamily = mod(floor(semantic / 131072.0), 8.0);
          if (abs(roofFamily - 6.0) < 0.5) return ${SURFACE_REGION.grassLush.toFixed(1)};
          return mod(floor(semantic / 16.0), 2.0) < 0.5
            ? ${SURFACE_REGION.roofGravel.toFixed(1)}
            : ${SURFACE_REGION.roofTar.toFixed(1)};
        }
        // Analytically filtered [a,b] band: a step() pair widened to the pixel
        // footprint w, so window edges resolve instead of aliasing.
        float band(float x, float a, float b, float w) {
          return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x));
        }`
      )
      .replace(
        '#include <normal_fragment_maps>',
        premiumSurfaceNormals
          ? `#include <normal_fragment_maps>
        {
          // MeshLambert has no useful UV layout across merged OSM footprints.
          // Reconstruct facade tangent space from the world normal, then project
          // the cached procedural normal maps in metres. Relief is limited to
          // opaque wall/roof pixels and fades before it can sparkle at distance.
          vec3 faceN = normalize(vWNormal) * (gl_FrontFacing ? 1.0 : -1.0);
          float verticalN = 1.0 - abs(faceN.y);
          float detailN = 1.0 - smoothstep(80.0, 260.0, distance(cameraPosition, vWPos));
          float styleN = floor(vStyle + 0.5);
          bool texturedMasonry = styleN < 0.5
            || abs(styleN - 4.0) < 0.5
            || abs(styleN - 5.0) < 0.5
            || abs(styleN - 7.0) < 0.5
            || abs(styleN - 8.0) < 0.5
            || abs(styleN - 10.0) < 0.5
            || abs(styleN - 11.0) < 0.5
            || abs(styleN - 13.0) < 0.5
            || abs(styleN - 14.0) < 0.5;
          if (verticalN > 0.55 && texturedMasonry && detailN > 0.001) {
            normal = normalize(mix(normal, mat3(viewMatrix) * nycMasonryNormal, nycMasonryWeight));
          } else if (faceN.y > 0.55 && detailN > 0.001) {
            float roofRegionN = nycRoofRegion(vSemantic);
            vec3 mapN = nycAtlasSample(
              uNycSurfaceNormal,
              nycSurfaceWarp(vWPos.xz) / 4.0,
              roofRegionN
            ).xyz * 2.0 - 1.0;
            mapN.xy *= 0.64;
            vec3 worldN = normalize(vec3(mapN.x, max(mapN.z, 0.3), mapN.y));
            normal = normalize(mat3(viewMatrix) * normalize(mix(faceN, worldN, detailN * 0.62)));
          }
        }`
          : '#include <normal_fragment_maps>'
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Double-sided: reversed-winding footprints (self-intersecting OSM
          // rings) render as normal facades either way, and any true opening
          // shows the far wall as a wall instead of a see-through void.
          vec3 wn = normalize(vWNormal) * (gl_FrontFacing ? 1.0 : -1.0);
          float vertical = 1.0 - abs(wn.y);
          float detail = 1.0 - smoothstep(
            uNycFacadeFadeStart,
            uNycFacadeFadeEnd,
            distance(cameraPosition, vWPos)
          );
          if (vertical > 0.55 && vWPos.y > 0.5) {
            vec3 facadeBase = diffuseColor.rgb;
            if (detail > 0.001 && vFacade.w >= 0.0) {
            float u = vFacade.x;
            float v = vFacade.y;
            float buildingSeed = vFacade.w;
            // Sixteen stable archetypes. Styles 0/1 intentionally retain the old
            // masonry/glass behavior, so tiles produced before the semantic
            // pipeline upgrade render identically.
            float semantic = floor(vSemantic + 0.5);
            float styleId = clamp(mod(semantic, 16.0), 0.0, 15.0);
            float windowFamily = mod(floor(semantic / 16.0), 8.0);
            float openingQ = mod(floor(semantic / 128.0), 16.0);
            float opening = 0.22 + openingQ * (0.58 / 15.0);
            float storefrontCategory = mod(floor(semantic / 2048.0), 8.0);
            bool glassTower = abs(styleId - 1.0) < 0.5 || abs(styleId - 6.0) < 0.5;
            bool semanticCurtain = abs(windowFamily - 1.0) < 0.5;
            bool curtainFacade = glassTower || semanticCurtain;
            bool architecturalMetal = abs(styleId - 6.0) < 0.5
              || abs(styleId - 8.0) < 0.5;
            bool industrial = abs(styleId - 4.0) < 0.5 || abs(styleId - 13.0) < 0.5;
            bool brownstone = abs(styleId - 5.0) < 0.5;
            bool concrete = abs(styleId - 3.0) < 0.5 || abs(styleId - 9.0) < 0.5;
            bool stone = abs(styleId - 2.0) < 0.5 || abs(styleId - 12.0) < 0.5;
            bool castIron = abs(styleId - 8.0) < 0.5;
            bool artDeco = abs(styleId - 10.0) < 0.5;
            bool hotel = abs(styleId - 15.0) < 0.5;
            float floorH = curtainFacade ? 3.4 : industrial ? 4.15 : brownstone ? 3.25
              : castIron ? 3.75 : hotel ? 3.45 : 3.1;
            float winW = abs(styleId - 6.0) < 0.5 ? 1.45
              : curtainFacade ? 1.7 : industrial ? 3.2 : concrete ? 3.35
              : brownstone ? 2.8 : castIron ? 2.25 : stone ? 2.6
              : abs(windowFamily - 4.0) < 0.5 ? 3.6
              : abs(windowFamily - 6.0) < 0.5 ? 2.9 : 2.5;
            // Center whole bays on each actual footprint edge. Stable seed
            // varies proportions by building, never individual glass panes.
            floorH *= mix(0.94, 1.08, buildingSeed);
            winW *= mix(0.87, 1.16, fract(buildingSeed * 7.31));
            float groundH = mix(3.65, 4.5, buildingSeed);
            bool hasStorefront = storefrontCategory > 0.5;
            bool storefront = hasStorefront && v >= 0.0 && v < groundH;
            float upperV = hasStorefront ? v - groundH : v;
            if (storefront) { floorH = groundH; winW = 3.6; upperV = v; }
            float bayCount = max(1.0, floor(vFacade.z / winW + 0.5));
            winW = max(0.5, vFacade.z / bayCount);
            // Cell coordinates BEFORE the fract(), so their screen-space
            // derivatives are continuous (fwidth of a fract() spikes at every
            // cell seam and would draw a bright line there).
            float cu = u / winW, cv = upperV / floorH;
            vec2 f = vec2(fract(cu), fract(cv));
            // Half a pixel in cell units, per axis. This is what turns a hard
            // step() into a properly filtered edge -- without it every window
            // mullion is a 1-bit test that crawls and sparkles as soon as a cell
            // is near pixel-sized, which is exactly the shimmer you fly through
            // in the helicopter.
            float wx = max(fwidth(cu), 1e-5) * 0.5;
            float wy = max(fwidth(cv), 1e-5) * 0.5;
            // Past ~1 cell per pixel no amount of filtering can resolve the
            // pattern, so cross-fade the whole grid to its own AREA AVERAGE.
            // Same mean tone, zero temporal noise.
            float lod = 1.0 - smoothstep(0.22, 0.62, max(wx, wy));
            // Sashes, sills and sun pinpricks disappear sooner than the broad
            // window area. Keeping sub-pixel micro-lines alive is what produces
            // dotted/crawling window fragments during helicopter motion.
            float microLod = 1.0 - smoothstep(0.08, 0.24, max(wx, wy));
            vec3 V = normalize(cameraPosition - vWPos);
            float fresnel = pow(1.0 - max(dot(V, wn), 0.0), 3.0);
            vec3 reflected = reflect(-V, wn);
            float skyLift = clamp(reflected.y * 0.55 + 0.55, 0.0, 1.0);
            vec3 skyGlass = mix(vec3(0.20, 0.27, 0.36), vec3(0.67, 0.76, 0.86), skyLift);
            vec3 sunDir = normalize(vec3(-0.48, 0.64, -0.40));
            float glint = pow(max(dot(reflect(-sunDir, wn), V), 0.0), 96.0) * microLod;

            if (curtainFacade && !storefront) {
              // curtain wall: thin mullions + spandrel band each floor
              float mull = mix(0.890, band(f.x, 0.055, 0.945, wx), lod);
              float pane = mix(0.660, band(f.y, 0.06, 0.72, wy), lod);
              float spandrel = mix(0.190, band(f.y, 0.78, 0.97, wy), lod);
              // One stable dielectric tint per building. Reflection varies
              // continuously with face/view geometry, never by pane id.
              vec3 solidGlassTint = mix(
                vec3(0.24, 0.34, 0.42),
                facadeBase,
                0.24
              );
              vec3 glass = mix(
                solidGlassTint,
                skyGlass,
                mix(0.30, 0.42 + fresnel * 0.42, lod)
              );
              if (semanticCurtain && !glassTower) {
                // The semantic curtain archetype is common across otherwise
                // bright masonry palettes. Preserve its continuous reflected
                // chroma without turning those entire blocks into sky emitters.
                const vec3 curtainLuma = vec3(0.2126, 0.7152, 0.0722);
                float facadeY = max(dot(facadeBase, curtainLuma), 0.08);
                float glassY = max(dot(glass, curtainLuma), 0.05);
                glass *= facadeY * mix(0.82, 1.02, fresnel) / glassY;
              }
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, mull * pane * 0.94);
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, spandrel * 0.8);
              diffuseColor.rgb += vec3(1.0, 0.94, 0.80) * glint * pane * 0.22;
            } else {
              float sideInset = mix(0.31, 0.08, opening);
              float bottomInset = mix(0.35, 0.12, opening);
              float inX = mix(opening, band(f.x, sideInset, 1.0 - sideInset, wx), lod);
              float inY = mix(opening, band(f.y, bottomInset, min(0.9, bottomInset + opening), wy), lod);
              if (abs(windowFamily - 5.0) < 0.5) {
                float archDistance = length(vec2((f.x - 0.5) * 0.65, f.y - 0.64));
                float archWidth = max(fwidth(archDistance), 0.002);
                float arch = 1.0 - smoothstep(
                  0.215 - archWidth,
                  0.215 + archWidth,
                  archDistance
                );
                inY *= mix(
                  1.0,
                  max(arch, band(f.y, bottomInset, 0.66, wy)),
                  microLod
                );
              }
              if (storefront) {
                inX = mix(0.840, band(f.x, 0.08, 0.92, wx), lod);
                inY = mix(0.700, band(f.y, 0.05, 0.75, wy), lod);
              }
              float win = inX * inY;
              // masonry surface detail between the windows (brightness only,
              // so each building keeps its palette color)
              float facadeRegion = nycFacadeRegion(styleId);
              float facadeScale = (facadeRegion == ${SURFACE_REGION.limestone.toFixed(1)} || facadeRegion == ${SURFACE_REGION.concreteAged.toFixed(1)}) ? 2.4 : 1.2;
              vec2 facadeRepeat = vec2(u, v) / facadeScale + vec2(buildingSeed * 11.0, 0.0);
              vec3 bt = nycAtlasSample(
                uNycSurfaceColor,
                facadeRepeat,
                facadeRegion
              ).rgb;
              ${surfaceOrm
                ? 'float facadeAo = nycAtlasSample(uNycSurfaceOrm, facadeRepeat, facadeRegion).r;'
                : 'float facadeAo = 1.0;'}
              ${premiumSurfaceNormals ? `
              vec3 masonryN = nycAtlasSample(uNycSurfaceNormal, facadeRepeat, facadeRegion).xyz * 2.0 - 1.0;
              vec3 tangent = normalize(vec3(wn.z, 0.0, -wn.x));
              vec3 relief = normalize(tangent * masonryN.x * 0.65 + vec3(0.0, 1.0, 0.0) * masonryN.y * 0.65 + wn * max(masonryN.z, 0.3));
              nycMasonryNormal = relief;
              nycMasonryWeight = (1.0 - win) * detail * microLod * 0.65;
              ` : ''}
              float bl = dot(bt, vec3(0.333)) * 2.4;
              float masonryRelief = industrial ? 0.82 : brownstone ? 0.72
                : castIron ? 0.16 : (stone || concrete || artDeco) ? 0.44 : 0.86;
              diffuseColor.rgb *= mix(1.0, bl, masonryRelief * (1.0 - win));
              diffuseColor.rgb *= mix(1.0, facadeAo, 0.18 * (1.0 - win));
              vec3 solidWindowTint = storefront
                ? mix(vec3(0.12, 0.15, 0.17), facadeBase, 0.08)
                : mix(vec3(0.16, 0.24, 0.31), facadeBase, 0.10);
              vec3 glass = mix(
                solidWindowTint,
                skyGlass,
                (storefront ? 0.15 : 0.24) + fresnel * 0.50
              );
              // Apartment shades, recessed rooms and curtains sit behind the
              // same continuous reflection; no random luminous pane checkerboard.
              float roomId = fract(sin(dot(floor(vec2(cu, cv)), vec2(17.13, 91.7)) + buildingSeed * 37.0) * 43758.5453);
              float shadeEnd = mix(0.4, 0.88, roomId);
              float blind = band(f.y, shadeEnd, 0.91, wy) * step(0.42, roomId);
              float curtain = (band(f.x, sideInset, sideInset + 0.10, wx)
                + band(f.x, 0.90 - sideInset, 1.0 - sideInset, wx)) * step(roomId, 0.3);
              vec3 interior = mix(vec3(0.045, 0.055, 0.063), vec3(0.34, 0.30, 0.24), clamp(blind + curtain, 0.0, 1.0));
              if (!storefront) glass = mix(glass, interior, (1.0 - fresnel) * microLod * 0.38);
              // window inset: lintel shadow at the top of the opening, darker jambs
              float lintel = 1.0 - 0.5 * mix(0.26, smoothstep(0.68, 0.8, f.y), lod) * win;
              float jamb = 1.0 - 0.28 * lod * (band(f.x, 0.18, 0.24, wx) + band(f.x, 0.79, 0.85, wx)) * inY;
              diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.98);
              diffuseColor.rgb *= lintel * jamb;
              diffuseColor.rgb += vec3(1.0, 0.94, 0.82) * glint * win * (storefront ? 0.07 : 0.11);
              // Real storefronts are divided into narrow display bays and a
              // transom; upper punched windows get a slim sash. These are only
              // shader masks, so the close-up read improves with no geometry.
              float frame = storefront
                ? microLod * ((band(f.x, 0.335, 0.355, wx) + band(f.x, 0.645, 0.665, wx)) * inY
                  + band(f.y, 0.54, 0.565, wy) * inX)
                : microLod * band(f.y, 0.505, 0.525, wy) * inX;
              if (abs(windowFamily - 2.0) < 0.5) {
                frame += microLod * ((band(f.x, 0.325, 0.345, wx) + band(f.x, 0.655, 0.675, wx)) * inY
                  + (band(f.y, 0.42, 0.44, wy) + band(f.y, 0.64, 0.66, wy)) * inX);
              }
              diffuseColor.rgb = mix(diffuseColor.rgb, facadeBase * 0.36, clamp(frame, 0.0, 1.0) * 0.92);
              // Limestone lintels, projecting sills and a darker reveal give
              // prewar masonry its depth; widths track the opening family.
              float lintelTrim = band(f.y, min(0.9, bottomInset + opening), min(0.96, bottomInset + opening + 0.045), wy) * inX * microLod;
              if (!storefront && !concrete) diffuseColor.rgb = mix(diffuseColor.rgb, facadeBase * 1.3, lintelTrim * 0.6);
              float sill = microLod * band(f.y, bottomInset - 0.035, bottomInset, wy) * inX;
              diffuseColor.rgb += vec3(0.05) * sill * (storefront ? 0.0 : 1.0);
              if (architecturalMetal) {
                float metalMask = 1.0 - win;
                diffuseColor.rgb = mix(
                  diffuseColor.rgb,
                  mix(facadeBase, skyGlass, 0.18 + fresnel * 0.12),
                  metalMask * 0.035
                );
              }
            }
            // At sub-pixel scale reflection detail disappears into neutral
            // massing. This matches the cheap tile material and prevents a
            // city-wide exposure jump as streamed LODs exchange.
            diffuseColor.rgb = mix(facadeBase, diffuseColor.rgb, detail);
            }
            // grounding gradient: subtle darkening near street
            float macroStyle = clamp(mod(floor(vSemantic + 0.5), 16.0), 0.0, 15.0);
            float macroWindow = mod(floor(floor(vSemantic + 0.5) / 16.0), 8.0);
            bool solidGlassFacade = abs(macroStyle - 1.0) < 0.5
              || abs(macroStyle - 6.0) < 0.5
              || abs(macroWindow - 1.0) < 0.5;
            float detailedBaseResponse =
              (0.86 + 0.14 * clamp(vFacade.y / 7.0, 0.0, 1.0))
              * (solidGlassFacade ? 1.0 : nycMacroVariation(vWPos.xz));
            diffuseColor.rgb *= mix(1.0, detailedBaseResponse, detail);
          } else if (wn.y > 0.55) {
            // roofs: ballast gravel, worldspace projected
            float roofRegion = nycRoofRegion(vSemantic);
            vec2 roofRepeat = nycSurfaceWarp(vWPos.xz) / 4.0;
            vec3 rt = nycAtlasSample(uNycSurfaceColor, roofRepeat, roofRegion).rgb;
            ${surfaceOrm
              ? 'float roofAo = nycAtlasSample(uNycSurfaceOrm, roofRepeat, roofRegion).r;'
              : 'float roofAo = 1.0;'}
            diffuseColor.rgb *= mix(vec3(1.0), rt * 1.9, 0.55)
              * mix(1.0, roofAo, 0.2) * nycMacroVariation(vWPos.xz);
          }
        }`
      );
  };
  return mat;
}

interface ProjectedSurfaceOptions {
  id: string;
  region: number;
  metersPerRepeat: number;
  normalStrength: number;
  aoStrength: number;
}

/**
 * Bind one atlas region to a whole merged tile layer. Sampling is projected
 * from absolute world coordinates, so adjacent tiles meet without UV seams and
 * broad analytic variation breaks repetition without another texture sample.
 */
function applyProjectedSurface(
  mat: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial,
  options: ProjectedSurfaceOptions,
): void {
  const contract = MATERIAL_TIER_CONTRACTS[quality().level];
  const normalEnabled = contract.normalAtlas;
  const ormEnabled = contract.ormAtlas && mat instanceof THREE.MeshStandardMaterial;
  const normalFragment = normalEnabled
    ? `
      if (abs(vNycMaterialWorldNormal.y) > 0.58) {
        vec3 nycMapN = nycAtlasSample(
          uNycMaterialNormal,
          nycSurfaceRepeat,
          ${options.region.toFixed(1)}
        ).xyz * 2.0 - 1.0;
        vec3 nycWorldN = normalize(vec3(
          nycMapN.x * ${options.normalStrength.toFixed(3)},
          max(0.28, nycMapN.z),
          nycMapN.y * ${options.normalStrength.toFixed(3)}
        ));
        normal = normalize(mix(normal, mat3(viewMatrix) * nycWorldN, 0.72));
      }`
    : '';
  const ormAssignment = ormEnabled
    ? `nycMaterialOrmSample = nycAtlasSample(
        uNycMaterialOrm,
        nycSurfaceRepeat,
        ${options.region.toFixed(1)}
      );`
    : '';
  const roughnessFragment = ormEnabled
    ? `float roughnessFactor = roughness * nycMaterialOrmSample.g;`
    : '#include <roughnessmap_fragment>';
  const metalnessFragment = ormEnabled
    ? 'float metalnessFactor = nycMaterialOrmSample.b;'
    : '#include <metalnessmap_fragment>';
  const aoFragment = ormEnabled
    ? `
      float nycAmbientOcclusion = mix(1.0, nycMaterialOrmSample.r, ${options.aoStrength.toFixed(3)});
      reflectedLight.indirectDiffuse *= nycAmbientOcclusion;
      #if defined( USE_ENVMAP ) && defined( STANDARD )
        float nycDotNV = saturate(dot(geometryNormal, geometryViewDir));
        reflectedLight.indirectSpecular *= computeSpecularOcclusion(
          nycDotNV, nycAmbientOcclusion, material.roughness
        );
      #endif`
    : '#include <aomap_fragment>';

  mat.userData.nycMaterialSurface = options.id;
  mat.userData.nycMaterialChannels = [
    'color',
    ...(normalEnabled ? ['normal'] : []),
    ...(ormEnabled ? ['orm'] : []),
  ];
  mat.customProgramCacheKey = () => `nyc-material-${options.id}-${normalEnabled ? 'n' : 'x'}-${ormEnabled ? 'o' : 'x'}-v2`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNycMaterialColor = materialLibrary.colorUniform;
    if (normalEnabled) shader.uniforms.uNycMaterialNormal = materialLibrary.normalUniform;
    if (ormEnabled) shader.uniforms.uNycMaterialOrm = materialLibrary.ormUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vNycMaterialWorld;
        varying vec3 vNycMaterialWorldNormal;`
      )
      .replace(
        '#include <defaultnormal_vertex>',
        `#include <defaultnormal_vertex>
        vNycMaterialWorldNormal = normalize(inverseTransformDirection(transformedNormal, viewMatrix));`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 nycMaterialWorldPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          nycMaterialWorldPosition = batchingMatrix * nycMaterialWorldPosition;
        #endif
        #ifdef USE_INSTANCING
          nycMaterialWorldPosition = instanceMatrix * nycMaterialWorldPosition;
        #endif
        vNycMaterialWorld = (modelMatrix * nycMaterialWorldPosition).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vNycMaterialWorld;
        varying vec3 vNycMaterialWorldNormal;
        uniform sampler2D uNycMaterialColor;
        ${normalEnabled ? 'uniform sampler2D uNycMaterialNormal;' : ''}
        ${ormEnabled ? `uniform sampler2D uNycMaterialOrm;
        vec4 nycMaterialOrmSample = vec4(1.0);` : ''}
        ${MATERIAL_ATLAS_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 nycSurfaceRepeat = nycSurfaceWarp(vNycMaterialWorld.xz)
          / ${options.metersPerRepeat.toFixed(4)};
        vec3 nycSurfaceColor = nycAtlasSample(
          uNycMaterialColor,
          nycSurfaceRepeat,
          ${options.region.toFixed(1)}
        ).rgb;
        diffuseColor.rgb *= nycSurfaceColor * nycMacroVariation(vNycMaterialWorld.xz);
        ${ormAssignment}`
      )
      .replace('#include <normal_fragment_maps>', normalFragment)
      .replace('#include <roughnessmap_fragment>', roughnessFragment)
      .replace('#include <metalnessmap_fragment>', metalnessFragment)
      .replace('#include <aomap_fragment>', aoFragment);
  };
}

/** Flat layer (areas/ground): vertex colors modulated by worldspace mottle. */
export function makeFlatMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const contract = MATERIAL_TIER_CONTRACTS[quality().level];
  const normalEnabled = contract.facadeNormals;
  const ormEnabled = contract.ormAtlas;
  mat.userData.nycMaterialSurface = 'grass-variants';
  mat.userData.nycMaterialChannels = [
    'color',
    ...(normalEnabled ? ['normal'] : []),
    ...(ormEnabled ? ['orm'] : []),
  ];
  mat.customProgramCacheKey = () => `nyc-material-grass-${normalEnabled ? 'n' : 'x'}-${ormEnabled ? 'o' : 'x'}-v2`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNycGrassColor = materialLibrary.colorUniform;
    if (normalEnabled) shader.uniforms.uNycGrassNormal = materialLibrary.normalUniform;
    if (ormEnabled) shader.uniforms.uNycGrassOrm = materialLibrary.ormUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGXZ;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vGXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vGXZ;
        uniform sampler2D uNycGrassColor;
        ${normalEnabled ? 'uniform sampler2D uNycGrassNormal;' : ''}
        ${ormEnabled ? 'uniform sampler2D uNycGrassOrm;' : ''}
        float nycGrassDry;
        float nycGrassBlend;
        vec2 nycGrassLushRepeat;
        vec2 nycGrassDryRepeat;
        ${MATERIAL_ATLAS_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          nycGrassDry = smoothstep(-0.35, 0.35,
            sin(vGXZ.x * 0.013 - vGXZ.y * 0.019)
            + sin(vGXZ.x * -0.007 + vGXZ.y * 0.011 + 1.8) * 0.6
          );
          nycGrassBlend = 0.42 + nycGrassDry * 0.18;
          vec2 grassWarp = nycSurfaceWarp(vGXZ);
          nycGrassLushRepeat = grassWarp / 5.3;
          nycGrassDryRepeat = (
            mat2(0.86, 0.31, -0.24, 1.07) * grassWarp
            + vec2(19.7, -11.3)
          ) / 7.1;
          vec3 detail = mix(
            nycAtlasSample(
              uNycGrassColor,
              nycGrassLushRepeat,
              ${SURFACE_REGION.grassLush.toFixed(1)}
            ).rgb,
            nycAtlasSample(
              uNycGrassColor,
              nycGrassDryRepeat,
              ${SURFACE_REGION.grassDry.toFixed(1)}
            ).rgb,
            nycGrassBlend
          );
          // The two atlas regions carry useful blade-scale color, but their
          // full contrast advertises the repeat from a helicopter. Preserve
          // the hue variation while damping only that high-frequency contrast.
          vec3 grassDetail = mix(vec3(0.49), detail, 0.58);
          diffuseColor.rgb *= grassDetail * 2.05 * nycMacroVariation(vGXZ);
          ${ormEnabled ? `
          float grassAo = mix(
            nycAtlasSample(
              uNycGrassOrm,
              nycGrassLushRepeat,
              ${SURFACE_REGION.grassLush.toFixed(1)}
            ).r,
            nycAtlasSample(
              uNycGrassOrm,
              nycGrassDryRepeat,
              ${SURFACE_REGION.grassDry.toFixed(1)}
            ).r,
            nycGrassBlend
          );
          diffuseColor.rgb *= mix(1.0, grassAo, 0.18);` : ''}
        }`
      )
      .replace(
        '#include <normal_fragment_maps>',
        normalEnabled
          ? `{
          vec3 lushN = nycAtlasSample(
            uNycGrassNormal,
            nycGrassLushRepeat,
            ${SURFACE_REGION.grassLush.toFixed(1)}
          ).xyz * 2.0 - 1.0;
          vec3 dryN = nycAtlasSample(
            uNycGrassNormal,
            nycGrassDryRepeat,
            ${SURFACE_REGION.grassDry.toFixed(1)}
          ).xyz * 2.0 - 1.0;
          vec3 mapN = normalize(mix(lushN, dryN, nycGrassBlend));
          vec3 worldN = normalize(vec3(mapN.x * 0.38, max(mapN.z, 0.42), mapN.y * 0.38));
          normal = normalize(mix(normal, mat3(viewMatrix) * worldN, 0.48));
        }`
          : ''
      );
  };
  return mat;
}

/**
 * Depth-only first pass for road geometry.
 *
 * The terrain and road ribbons use independent triangulations, so the terrain
 * can physically cross a road even when the centerline was sampled from the
 * same elevation grid. This pass replaces base-surface depth under projected
 * road pixels without touching color. The ordinary road pass immediately
 * follows it with normal depth testing, restoring the nearest road/bridge at
 * overlaps; buildings, sidewalks, actors, and markings render afterward.
 */
export function makeRoadDepthMaskMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
  });
  mat.userData.nycRoadDepthMask = true;
  return mat;
}

/** Asphalt roadbed with aggregate normal detail (UVs from the worker). */
export function makeRoadMaterial(): THREE.MeshLambertMaterial | THREE.MeshStandardMaterial {
  const q = quality();
  const contract = MATERIAL_TIER_CONTRACTS[q.level];
  // Full roughness response is reserved for desktop; the mobile Lambert path
  // keeps the exact same albedo/normal read without paying for IBL per pixel.
  const mat = contract.pbrStreet
    ? new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xffffff, roughness: 1, metalness: 0 })
    : new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xffffff });
  mat.dithering = true;
  applyProjectedSurface(mat, {
    id: 'asphalt-worn',
    region: SURFACE_REGION.asphaltWorn,
    metersPerRepeat: 4,
    normalStrength: 0.68,
    aoStrength: 0.34,
  });
  return mat;
}

/** Poured-concrete walks with score joints. */
export function makeWalkMaterial(): THREE.MeshLambertMaterial | THREE.MeshStandardMaterial {
  const q = quality();
  const contract = MATERIAL_TIER_CONTRACTS[q.level];
  const mat = contract.pbrStreet
    ? new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xffffff, roughness: 1, metalness: 0 })
    : new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xffffff });
  mat.dithering = true;
  applyProjectedSurface(mat, {
    id: 'concrete-aged',
    region: SURFACE_REGION.concreteAged,
    metersPerRepeat: 3,
    normalStrength: 0.76,
    aoStrength: 0.3,
  });
  return mat;
}

/**
 * Lambert with a worldspace-projected detail map (for floors/slabs that share
 * one material across many differently-sized boxes, where per-face UVs stretch).
 */
export function makeWorldDetailMaterial(
  color: THREE.ColorRepresentation,
  detail: THREE.Texture,
  metersPerRepeat: number,
  amount = 0.75,
): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.uniforms.uScale = { value: 1 / metersPerRepeat };
    shader.uniforms.uAmt = { value: amount };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDXZ;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 detailPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          detailPosition = instanceMatrix * detailPosition;
        #endif
        vDXZ = (modelMatrix * detailPosition).xz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDXZ;\nuniform sampler2D uDetail;\nuniform float uScale;\nuniform float uAmt;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), texture2D(uDetail, vDXZ * uScale).rgb * 1.28, uAmt);`
      );
  };
  return mat;
}

/** Painted lane lines / crosswalk bars: slightly emissive so they pop in shade. */
export function makeMarkingsMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    emissive: 0xffffff,
    emissiveIntensity: 0.08,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return mat;
}

/** Distant skyline: unlit-ish, exempt from fog, hazes toward sky color with distance. */
export function makeSkylineMaterial(skyColor: THREE.Color): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0x6a7280, fog: false });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSky = { value: skyColor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vDist;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vDist = length((modelViewMatrix * vec4(transformed, 1.0)).xyz);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDist;\nuniform vec3 uSky;')
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        // wash quickly to ~0.85 near the tile-fog boundary (continuity with fogged
        // tiles), then drift toward sky slowly so far towers stay soft silhouettes
        float haze = 0.85 * smoothstep(500.0, 1500.0, vDist)
                   + 0.11 * smoothstep(1500.0, 6500.0, vDist);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uSky, clamp(haze, 0.0, 0.96));`
      );
  };
  return mat;
}

export const treeTrunkMaterial = () => {
  const q = quality();
  // Low avoids bark samples; at the tier's 1x cap the five-sided trunk is
  // primarily a silhouette. Other tiers share the city atlas, so adding trees
  // never creates another pair of resident textures.
  if (q.level === 'low') {
    return new THREE.MeshLambertMaterial({ color: 0x806a56 });
  }
  const pbr = q.level === 'high' || q.level === 'ultra';
  const mat = pbr
    ? new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, metalness: 0,
    })
    : new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.dithering = true;
  mat.userData.nycMaterialSurface = 'bark-brown';
  mat.userData.nycMaterialChannels = ['color', ...(pbr ? ['orm'] : [])];
  mat.customProgramCacheKey = () => `nyc-material-bark-${pbr ? 'pbr' : 'lambert'}-v1`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNycBarkColor = materialLibrary.colorUniform;
    if (pbr) shader.uniforms.uNycBarkOrm = materialLibrary.ormUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vNycBarkUv;
        varying vec2 vNycBarkWorld;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vNycBarkUv = vec2(uv.x * 2.0, uv.y * 3.0);
        vec4 nycBarkWorldPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          nycBarkWorldPosition = instanceMatrix * nycBarkWorldPosition;
        #endif
        vNycBarkWorld = (modelMatrix * nycBarkWorldPosition).xz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vNycBarkUv;
        varying vec2 vNycBarkWorld;
        uniform sampler2D uNycBarkColor;
        ${pbr ? `uniform sampler2D uNycBarkOrm;
        vec4 nycBarkOrmSample = vec4(1.0);` : ''}
        ${MATERIAL_ATLAS_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 nycBarkAtlasUv = nycAtlasUv(vNycBarkUv, ${SURFACE_REGION.barkBrown.toFixed(1)});
        diffuseColor.rgb *= texture2D(uNycBarkColor, nycBarkAtlasUv).rgb
          * 1.95 * nycMacroVariation(vNycBarkWorld);
        ${pbr ? 'nycBarkOrmSample = texture2D(uNycBarkOrm, nycBarkAtlasUv);' : ''}`
      );
    if (pbr) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <roughnessmap_fragment>',
          'float roughnessFactor = roughness * nycBarkOrmSample.g;'
        )
        .replace(
          '#include <metalnessmap_fragment>',
          'float metalnessFactor = nycBarkOrmSample.b;'
        )
        .replace(
          '#include <aomap_fragment>',
          'reflectedLight.indirectDiffuse *= mix(1.0, nycBarkOrmSample.r, 0.24);'
        );
    }
  };
  return mat;
};

export interface TreeCanopyMaterialKit {
  mat: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;
  /** Advance one shared wind phase for every instanced canopy in the city. */
  update: (dt: number) => void;
}

/**
 * Opaque instanced foliage with a cheap shared wind/translucency cue.
 *
 * Near crowns use opaque leaf sprays; distant crowns use closed meshes.
 * Neither needs alpha cards, blending or sorting. Wind runs in the shared vertex program and uses each instance's
 * world translation as its phase, so an entire tile is still one draw.
 */
export function treeCanopyMaterial(): TreeCanopyMaterialKit {
  const q = quality();
  const premium = q.level === 'high' || q.level === 'ultra';
  const animated = q.level !== 'low';
  // Leaf geometry, diffuse color and backlighting carry the foliage detail.
  // Avoid a GGX specular BRDF on thousands of rough, overlapping leaves.
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.dithering = true;
  mat.vertexColors = true;
  mat.side = THREE.DoubleSide;
  const uTime = { value: 0 };

  if (animated) {
    const windAmp = premium ? 0.075 : 0.04;
    const transmit = premium ? 0.12 : 0.055;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTreeTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTreeTime;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            // Lower vertices stay tied to the trunk; upper crown vertices move
            // a few centimetres. World-position phase prevents tiled lockstep.
            float treeCrown = smoothstep(1.25, 4.8, position.y);
            float treePhase = instanceMatrix[3].x * 0.031 + instanceMatrix[3].z * 0.023;
            float treeGust = sin(uTreeTime * 0.82 + treePhase)
              + 0.38 * sin(uTreeTime * 1.71 + treePhase * 1.83);
            transformed.x += treeGust * treeCrown * ${windAmp.toFixed(3)};
            transformed.z += sin(uTreeTime * 0.67 + treePhase * 1.27)
              * treeCrown * ${(windAmp * 0.58).toFixed(3)};
          #endif`
        );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // A restrained thin-leaf cue on the sun-opposed side of the closed
          // crown. This is lighting only—there is no transparent overdraw.
          vec3 treeSunView = normalize((viewMatrix * vec4(-0.5566, 0.6875, -0.4665, 0.0)).xyz);
          float treeBack = max(dot(-normal, treeSunView), 0.0);
          treeBack *= treeBack;
          reflectedLight.indirectDiffuse += diffuseColor.rgb
            * vec3(0.55, 0.82, 0.28) * treeBack * ${transmit.toFixed(3)};
        }`
      );
    };
    mat.customProgramCacheKey = () => `nycroam-tree-canopy-${q.level}`;
  }

  return {
    mat,
    update: animated
      ? (dt: number) => { uTime.value += Math.min(0.1, Math.max(0, dt)); }
      : () => {},
  };
}

/**
 * Animated river water: worldspace wave normals, fresnel toward the sky at
 * grazing angles, and a tight sun glint. Call the returned update(dt) per frame.
 */
export function makeWaterMaterial(skyColor: THREE.Color): { mat: THREE.MeshLambertMaterial; update: (dt: number) => void } {
  const mat = new THREE.MeshLambertMaterial({ color: 0x243f3d });
  const uTime = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uSky = { value: skyColor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWaterPos;
        uniform float uTime;
        uniform vec3 uSky;
        // Waves are three octaves of sine, wavelengths roughly 18 m / 70 m /
        // 140 m. The plane is 60 km across, so at the horizon a single pixel
        // spans hundreds of metres and every one of those octaves aliases into
        // a crawling moire -- the hatched band that used to sit across the
        // skyline. Each octave is faded out once the pixel footprint approaches
        // its own wavelength, which is the analytic version of a mip chain.
        vec3 waveNormal(vec2 p, float t, float px) {
          float f1 = 1.0 - smoothstep(2.5, 11.0, px);
          float f2 = 1.0 - smoothstep(9.0, 42.0, px);
          float f3 = 1.0 - smoothstep(22.0, 105.0, px);
          float nx = sin(p.x * 0.35 + t * 1.1) * 0.10 * f1
                   + sin((p.x + p.y) * 0.09 + t * 0.45) * 0.14 * f2
                   + sin(p.x * 0.045 - t * 0.22) * 0.20 * f3;
          float nz = cos(p.y * 0.31 + t * 0.9) * 0.10 * f1
                   + cos((p.y - p.x) * 0.075 + t * 0.35) * 0.14 * f2
                   + cos(p.y * 0.05 + t * 0.18) * 0.20 * f3;
          // Sub-metre wind chop is visible beside the seawall, but filtered
          // away before it becomes distant sparkle. Advect through the swell.
          float chop = 1.0 - smoothstep(0.06, 0.38, px);
          vec2 drift = p + vec2(t * .31, -t * .17);
          nx += (sin(dot(drift, vec2(5.1, 2.7))) * .07
            + sin(dot(drift, vec2(-3.3, 7.2)) + t*.6) * .04) * chop;
          nz += (cos(dot(drift, vec2(4.2, -3.8))) * .07
            + cos(dot(drift, vec2(6.7, 2.3)) - t*.5) * .04) * chop;
          return normalize(vec3(nx, 1.0, nz));
        }
        float waterPixelSpan() {
          return max(length(vec2(dFdx(vWaterPos.x), dFdy(vWaterPos.x))),
                     length(vec2(dFdx(vWaterPos.z), dFdy(vWaterPos.z))));
        }`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal = normalize(mat3(viewMatrix) * waveNormal(vWaterPos.xz, uTime, waterPixelSpan()));`
      )
      // Ahead of the fog, not after it: fresnel and glint are surface response,
      // so the haze has to sit on top of them. Injected at <dithering_fragment>
      // they were added AFTER <fog_fragment> and the glint stayed at full
      // strength through kilometres of air.
      .replace(
        '#include <fog_fragment>',
        `{
          float px = waterPixelSpan();
          vec3 V = normalize(cameraPosition - vWaterPos);
          vec3 N = waveNormal(vWaterPos.xz, uTime, px);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uSky, clamp(fres * 0.7, 0.0, 0.7));
          // A pow(.,120) lobe is a sub-pixel feature almost everywhere on a
          // 60 km plane; keep it only where the surface is actually resolved.
          float sharp = 1.0 - smoothstep(1.5, 7.0, px);
          vec3 sunDir = vec3(-0.5566, 0.6875, -0.4665);
          float glint = pow(max(dot(reflect(-sunDir, N), V), 0.0), 120.0);
          gl_FragColor.rgb += vec3(1.0, 0.95, 0.82) * glint * 0.55 * sharp;
        }
        #include <fog_fragment>`
      );
  };
  return { mat, update: (dt: number) => { uTime.value += dt; } };
}

/** Authored landmarks share the city atlas but retain their surveyed shapes
 * and palettes. One dominant-axis projection avoids per-landmark texture loads. */
export function applyLandmarkSurface<T extends THREE.MeshLambertMaterial | THREE.MeshStandardMaterial>(
  material: T, region: number, meters = 2.4, strength = 0.38,
): T {
  const normalEnabled = MATERIAL_TIER_CONTRACTS[quality().level].normalAtlas;
  material.onBeforeCompile = shader => {
    shader.uniforms.uLandmarkColor = materialLibrary.colorUniform;
    if (normalEnabled) shader.uniforms.uLandmarkNormal = materialLibrary.normalUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLmPos;\nvarying vec3 vLmNormal;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vLmPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vLmNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLmPos; varying vec3 vLmNormal;
        uniform sampler2D uLandmarkColor;
        ${normalEnabled ? 'uniform sampler2D uLandmarkNormal;' : ''}
        ${MATERIAL_ATLAS_GLSL}
        vec2 lmUV() {
          vec3 n = normalize(vLmNormal);
          return (abs(n.y) > 0.65 ? vLmPos.xz : vec2(vLmPos.x * n.z - vLmPos.z * n.x, vLmPos.y)) / ${meters.toFixed(3)};
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float lmLuma = dot(nycAtlasSample(uLandmarkColor, lmUV(), ${region.toFixed(1)}).rgb, vec3(0.333));
        float lmFade = 1.0 - smoothstep(100.0, 350.0, distance(cameraPosition, vLmPos));
        diffuseColor.rgb *= mix(1.0, clamp(lmLuma * 2.5, 0.52, 1.45), ${strength.toFixed(3)} * lmFade);`);
    if (normalEnabled) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      vec3 lmN = normalize(vLmNormal);
      vec3 lmT = abs(lmN.y) > .65 ? vec3(1.0, 0.0, 0.0) : normalize(vec3(lmN.z, 0.0, -lmN.x));
      vec3 lmB = normalize(cross(lmN, lmT));
      vec3 lmMap = nycAtlasSample(uLandmarkNormal, lmUV(), ${region.toFixed(1)}).xyz * 2.0 - 1.0;
      vec3 lmRelief = normalize(lmT * lmMap.x * .4 + lmB * lmMap.y * .4 + lmN * max(.4, lmMap.z));
      normal = normalize(mix(normal, mat3(viewMatrix) * lmRelief, lmFade * .42));`);
  };
  material.customProgramCacheKey = () => `landmark-scan-${region}-${meters}-${strength}-${normalEnabled}-v1`;
  return material;
}
