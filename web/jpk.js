/** Independent classic-TIFF JPK image adapter; supported subset: docs/jpk-support.md. */
const MAX_BYTES = 512 * 1024 * 1024;
const TYPE_SIZE = [0,1,1,2,4,8,1,1,2,4,8,4,8];
const UNIT = new Map([['m',[1,'m']],['mm',[1e-3,'m']],['um',[1e-6,'m']],['µm',[1e-6,'m']],['nm',[1e-9,'m']],['pm',[1e-12,'m']],['V',[1,'V']],['mV',[1e-3,'V']],['A',[1,'A']],['nA',[1e-9,'A']],['N',[1,'N']],['nN',[1e-9,'N']],['Pa',[1,'Pa']],['deg',[1,'deg']],['rad',[1,'rad']],['Hz',[1,'Hz']],['Arb',[1,'Arb']],['1',[1,'1']]]);
function fail(message) {throw new Error(`TIFF/JPK: ${message}`);}
function scalar(tags,tag,fallback) {
  const value=tags.get(tag)?.value;
  if(value===undefined && fallback!==undefined)return fallback;
  if(!Array.isArray(value)||value.length!==1||!Number.isFinite(value[0]))fail(`missing or invalid numeric tag 0x${tag.toString(16)}`);
  return value[0];
}
function string(tags,tag,fallback) {
  const value=tags.get(tag)?.value;
  if(value===undefined&&fallback!==undefined)return fallback;
  if(typeof value!=='string'||!value.length)fail(`missing or invalid text tag 0x${tag.toString(16)}`);
  return value;
}
function positive(value,label){if(!Number.isSafeInteger(value)||value<1)fail(`invalid ${label}`);return value;}
function tiff(buffer) {
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<8||buffer.byteLength>MAX_BYTES)fail('truncated or oversized classic TIFF file');
  const v=new DataView(buffer),b=new Uint8Array(buffer),little=b[0]===73&&b[1]===73;
  if(!(little||b[0]===77&&b[1]===77)||v.getUint16(2,little)!==42)fail('only classic TIFF images are supported; BigTIFF/other encodings are unsupported');
  const bounds=(offset,size)=>{if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset+size>b.length)fail('truncated or out-of-range TIFF payload');};
  const pages=[],seen=new Set(),metadataRanges=[{start:0,end:8}],warnings=[];let at=v.getUint32(4,little),totalTags=0;
  while(at) {
    if(seen.has(at))fail('cyclic IFD chain');seen.add(at);
    if(pages.length>=257)fail('too many IFDs');bounds(at,2);
    const count=v.getUint16(at,little);totalTags+=count;
    if(count>4096||totalTags>16384)fail('too many TIFF tags');
    bounds(at,2+count*12+4);metadataRanges.push({start:at,end:at+2+count*12+4});
    const tags=new Map();
    for(let i=0;i<count;i++) {
      const p=at+2+12*i,tag=v.getUint16(p,little),type=v.getUint16(p+2,little),n=v.getUint32(p+4,little),size=TYPE_SIZE[type]*n;
      if(tags.has(tag))fail('duplicate TIFF tag');
      if(!TYPE_SIZE[type]||!n||size>4*1024*1024)fail('unsupported TIFF tag type/count');
      const offset=size<=4?p+8:v.getUint32(p+8,little);bounds(offset,size);
      if(size>4)metadataRanges.push({start:offset,end:offset+size});
      let value;
      if(type===2) {
        let data=b.subarray(offset,offset+size),end=data.indexOf(0);if(end>=0)data=data.subarray(0,end);
        try{value=new TextDecoder('utf-8',{fatal:true}).decode(data);}
        catch{value=new TextDecoder('windows-1252').decode(data);warnings.push('TIFF text required Windows-1252 decoding; source bytes retained.');}
      } else {
        value=[];
        for(let j=0;j<n;j++) {
          const q=offset+j*TYPE_SIZE[type];
          const methods={1:'getUint8',3:'getUint16',4:'getUint32',6:'getInt8',7:'getUint8',8:'getInt16',9:'getInt32',11:'getFloat32',12:'getFloat64'};
          value.push(type===5?v.getUint32(q,little)/v.getUint32(q+4,little):type===10?v.getInt32(q,little)/v.getInt32(q+4,little):v[methods[type]](q,little));
        }
      }
      tags.set(tag,{type,count:n,value});
    }
    pages.push({index:pages.length,tags});at=v.getUint32(at+2+count*12,little);
  }
  if(!pages.length)fail('missing image directories');
  // All referenced strips are bounded and disjoint, including ignored thumbnails.
  const strips=[];
  for(const page of pages) {
    const offsets=page.tags.get(273)?.value,lengths=page.tags.get(279)?.value;
    if(!Array.isArray(offsets)||!Array.isArray(lengths)||offsets.length!==lengths.length||offsets.length>65536)fail('invalid strip offset/count arrays');
    page.strips=offsets.map((start,i)=>{const length=positive(lengths[i],'strip length');bounds(start,length);const r={start,end:start+length,length};strips.push(r);return r;});
  }
  const ordered=[...strips].sort((a,b)=>a.start-b.start);
  for(let i=1;i<ordered.length;i++)if(ordered[i].start<ordered[i-1].end)fail('overlapping strip payloads');
  for(const strip of strips)for(const r of metadataRanges)if(strip.start<r.end&&r.start<strip.end)fail('strip overlaps TIFF header or metadata');
  return {view:v,little,pages,warnings};
}
function calibration(tags) {
  const count=positive(scalar(tags,0x8080),'calibration slot count');if(count>32)fail('too many calibration slots');
  const slots=new Map();
  for(let i=0;i<count;i++) {
    const base=0x8090+0x30*i,name=string(tags,base);
    if(slots.has(name))fail('ambiguous duplicate calibration slot name');
    slots.set(name,{base,name,type:string(tags,base+1),parent:string(tags,base+2,'')});
  }
  const name=string(tags,0x8081),slot=slots.get(name);if(!slot)fail('default calibration slot not found');
  const visited=new Set();let current=slot;
  while(current) {
    if(visited.has(current.name))fail('cyclic calibration provenance');visited.add(current.name);
    if(current.type==='AbsoluteCalibration')break;
    if(current.type!=='RelativeCalibration')fail('unsupported default-slot calibration provenance');
    current=slots.get(current.parent);if(!current)fail('missing calibration parent slot');
  }
  const scaling=string(tags,slot.base+0x13),dataType=string(tags,slot.base+0x11);
  let multiplier=1,offset=0;
  if(scaling==='LinearScaling') {multiplier=scalar(tags,slot.base+0x14);offset=scalar(tags,slot.base+0x15);if(!multiplier)fail('zero calibration multiplier');}
  else if(scaling!=='NullScaling')fail('unsupported scaling; only explicit LinearScaling/NullScaling are supported');
  const storedUnit=string(tags,slot.base+0x12,''),conversion=UNIT.get(storedUnit),factor=conversion?.[0]??1;
  const warnings=[];
  if(!storedUnit)warnings.push('Unknown vertical unit: raw/calibrated slot values retained without assuming physical height.');
  else if(!conversion)warnings.push(`Unverified vertical unit ${storedUnit}: retained as written; no physical conversion inferred.`);
  return {name,multiplier,offset,factor,unit:conversion?.[1]??(storedUnit||null),storedUnit,dataType,scaling,slots:[...slots.values()],warnings};
}
const metadata = tags => Object.fromEntries([...tags].map(([tag,record])=>[`TIFF tag 0x${tag.toString(16)}`,typeof record.value==='string'?record.value:JSON.stringify(record.value)]));
export function parseJpk(buffer) {
  const file=tiff(buffer),global=file.pages[0].tags;
  if(string(global,0x8050,'')!=='thumbnail'||!global.has(0x8000)||!global.has(0x8042)||!global.has(0x8043))fail('ordinary TIFF or unidentified instrument TIFF is unsupported; requires JPK image metadata');
  const xreal=scalar(global,0x8042),yreal=scalar(global,0x8043);
  if(!(xreal>0&&yreal>0))fail('invalid lateral calibration');
  const gridWidth=positive(scalar(global,0x8046),'grid width'),gridHeight=positive(scalar(global,0x8047),'grid height');
  if(string(global,0x804b)!=='bottomUp'||scalar(global,0x8045)!==0)fail('unsupported grid direction/reflection configuration');
  const software=string(global,0x8000),mode=string(global,0x8030,'unknown'),settings=string(global,0x8017,'');
  const knownConfig=!file.little&&software==='6.0.41'&&mode==='ac-ultra-speed-direct-drive'&&scalar(global,0x8001,0)===2&&settings.includes('xy-scanner.tip-scanner.xy-scanner.name : tip-scanner')&&settings.includes('z-scanners.active-z-scanner.name : internal-z-scanner');
  const channels=Object.create(null),unsupported=[],unsupported_channels=[],warnings=[...file.warnings];let decoded=0;
  for(const page of file.pages.slice(1)) {
    const tags=page.tags,id=String(page.index-1);let title=`IFD ${page.index}`;
    try {
      const name=string(tags,0x8050);if(name==='thumbnail'){unsupported.push(`IFD ${page.index}: thumbnail skipped`);continue;}
      const retrace=scalar(tags,0x8051);if(![0,1].includes(retrace))fail('unsupported trace/retrace flag');
      title=`${name}_${retrace?'retrace':'trace'}`;
      const width=positive(scalar(tags,256),'image width'),height=positive(scalar(tags,257),'image height');
      if(width!==gridWidth||height!==gridHeight)fail('image dimensions differ from calibrated scan grid');
      if(width*height>MAX_BYTES/8||decoded+width*height*8>MAX_BYTES)fail('decoded image size limit exceeded');
      if(scalar(tags,259,1)!==1)fail('unsupported TIFF compression');
      if(scalar(tags,277,1)!==1||scalar(tags,284,1)!==1||scalar(tags,262)!==1||scalar(tags,274,1)!==1||scalar(tags,317,1)!==1||[322,323,324,325,330].some(t=>tags.has(t)))fail('unsupported color, orientation, predictor, tiled or sub-IFD raster');
      const bits=scalar(tags,258),sampleFormat=scalar(tags,339,1);
      if(![16,32].includes(bits)||![1,2].includes(sampleFormat))fail('only signed/unsigned 16/32-bit integer rasters are supported');
      const rows=positive(scalar(tags,278,height),'rows per strip'),expected=Math.ceil(height/rows);
      if(page.strips.length!==expected)fail('strip count does not match image rows');
      for(let i=0;i<expected;i++)if(page.strips[i].length!==Math.min(rows,height-i*rows)*width*(bits/8))fail('strip byte count does not match image dimensions');
      const cal=calibration(tags);
      if(cal.dataType!==(sampleFormat===2?'SignedInteger':'UnsignedInteger'))fail('slot storage type does not match TIFF sample format');
      const data=new Float64Array(width*height),method=`get${sampleFormat===2?'Int':'Uint'}${bits}`;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const rawY=height-1-y,strip=page.strips[Math.floor(rawY/rows)],address=strip.start+((rawY%rows)*width+x)*(bits/8);
        const value=(file.view[method](address,file.little)*cal.multiplier+cal.offset)*cal.factor;
        if(!Number.isFinite(value))fail('calibration produces nonfinite values');data[y*width+x]=value;
      }
      decoded+=data.byteLength;
      const notes=[...cal.warnings,'JPK default-slot multiplier and offset applied once to raw counts. Image-local coordinates; rows reversed once, columns unchanged. Grid origin and rotation retained as metadata, not applied.'];
      if(!knownConfig||bits!==32||sampleFormat!==2)notes.push('Unverified JPK instrument/configuration: calibration fields are readable but this acquisition/encoding combination has not been independently validated.');
      channels[id]={id,title,width,height,shape:[height,width],xreal,yreal,xoff:0,yoff:0,xy_unit:'m',z_unit:cal.unit,data,mask:null,log:[],selections:{},warnings:notes,metadata:{...metadata(global),...metadata(tags),'Import / reader':'JPK classic TIFF image adapter 1','Import / IFD':String(page.index),'Import / byte order':file.little?'little-endian':'big-endian','Import / calibration':JSON.stringify(cal),'Import / instrument configuration':`${software} / ${mode}`}};
    } catch(error) {unsupported.push(`IFD ${page.index} (${title}): ${error.message}`);unsupported_channels.push({id,title,reason:error.message});}
  }
  if(!Object.keys(channels).length)fail(`no supported calibrated JPK image channels. ${unsupported.join('; ')}`);
  if(unsupported_channels.length)warnings.push(`${unsupported_channels.length} image channel(s) omitted with explicit unsupported-configuration reasons.`);
  const validated=knownConfig&&Object.values(channels).every(c=>!c.warnings.some(w=>w.startsWith('Unverified JPK')));
  const support={status:validated?'validated':'unverified',format:'JPK_TIFF',configuration:`JPK software ${software} / ${mode} / ${validated?'internal tip and Z scanner':'unverified scanner configuration'}`,message:validated?'Supported JPK 6.0.41 uncompressed signed32 image subset. Stored calibration is used; acquisition accuracy is not certified.':'Unverified JPK instrument/configuration. Review calibration and acquisition metadata before quantitative use.'};
  if(!validated)warnings.push(support.message);
  return {format:'JPK_TIFF',channels,unsupported,unsupported_channels,warnings,support};
}
