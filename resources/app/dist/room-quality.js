const MiB = 1024 ** 2;

export const QUALITY_PRESETS = Object.freeze({
  power: Object.freeze({ id:'power', label:'省电', pixelRatio:1, shadows:false, shadowSize:512, shadowSamples:2, anisotropy:1, coverDimension:512, coverBudgetBytes:24*MiB, coverCount:18, coverConcurrency:2, dust:false }),
  balanced: Object.freeze({ id:'balanced', label:'平衡', pixelRatio:1.5, shadows:true, shadowSize:1024, shadowSamples:4, anisotropy:4, coverDimension:1024, coverBudgetBytes:96*MiB, coverCount:32, coverConcurrency:4, dust:true }),
  fine: Object.freeze({ id:'fine', label:'精细', pixelRatio:2, shadows:true, shadowSize:2048, shadowSamples:8, anisotropy:8, coverDimension:1600, coverBudgetBytes:192*MiB, coverCount:48, coverConcurrency:4, dust:true }),
});

export function normalizeQuality(value) {
  return Object.hasOwn(QUALITY_PRESETS,value) ? value : 'balanced';
}

export function getQualityPreset(value) {
  return QUALITY_PRESETS[normalizeQuality(value)];
}

export function textureMemoryBytes(texture) {
  const image=texture?.image;
  const width=Number(image?.naturalWidth||image?.width)||0,height=Number(image?.naturalHeight||image?.height)||0;
  return Math.ceil(width*height*4*(texture?.generateMipmaps===false?1:4/3));
}

// Keep cover UV cropping and source aspect metadata, while limiting the actual
// decoded image uploaded to the GPU. Quality changes reload the original URL.
export function limitCoverTexture(texture,dimension) {
  const source=texture.image,width=Number(source?.naturalWidth||source?.width),height=Number(source?.naturalHeight||source?.height);
  if(!width||!height||Math.max(width,height)<=dimension)return texture;
  const scale=dimension/Math.max(width,height),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  const context=canvas.getContext('2d');
  if(!context)return texture;
  context.drawImage(source,0,0,canvas.width,canvas.height);
  texture.image=canvas;texture.needsUpdate=true;
  return texture;
}
