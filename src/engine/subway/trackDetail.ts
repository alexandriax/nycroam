import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
type Track = (resource: THREE.BufferGeometry | THREE.Material) => void;

/** One instanced submission per track for sleepers and rail fastening plates. */
export function trackDetail(length: number, centerX: number, railY: number, z: number, track: Track): THREE.InstancedMesh {
  const pieces: THREE.BufferGeometry[] = [];
  const box = (w:number,h:number,d:number,x:number,y:number,z:number,color:number) => {
    const geometry = new THREE.BoxGeometry(w,h,d).translate(x,y,z);
    const c = new THREE.Color(color), colors = new Float32Array(geometry.attributes.position.count*3);
    for(let i=0;i<colors.length;i+=3) { colors[i]=c.r; colors[i+1]=c.g; colors[i+2]=c.b; }
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3)); pieces.push(geometry);
  };
  box(.24,.13,2.5,0,-.29,0,0x514536);
  for(const side of [-1,1]) {
    box(.29,.035,.27,0,-.206,side*.72,0x52565a);
    for(const edge of [-1,1]) box(.055,.055,.05,0,-.165,side*.72+edge*.10,0x717475);
  }
  const geometry = mergeGeometries(pieces,false)!; pieces.forEach(g=>g.dispose()); track(geometry);
  const material = new THREE.MeshLambertMaterial({vertexColors:true}); track(material);
  const count = Math.ceil(length/.65), mesh = new THREE.InstancedMesh(geometry,material,count);
  const matrix = new THREE.Matrix4();
  for(let i=0;i<count;i++) mesh.setMatrixAt(i,matrix.makeTranslation(centerX-length/2+(i+.5)*length/count,railY,z));
  mesh.name='Track sleepers and fastenings'; mesh.instanceMatrix.needsUpdate=true; mesh.computeBoundingSphere();
  return mesh;
}
