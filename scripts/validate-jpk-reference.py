#!/usr/bin/env python3
"""Dev-only JPK evidence generator: external pinned AFMReader and tifffile."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import tifffile
from AFMReader import jpk
from loguru import logger

FIXTURE_SHA = '02d0e0a57a66dd3353957e9658f4a8360ba299000de20ce135b3f14907ba8712'
READER_SHA = '4ee8212d76f1cb0b1f5f9ae97fac4a8e84136a92645aa17ba73a10a2e7200fdf'
TIFF_SHA = '42cfd527fb4bd18ef95095f04cf2245b8dcdf7d8cb2e5cd740417acf4f3cdbb5'
COMMIT = 'caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77'


def serial(x):
    if isinstance(x, np.ndarray): return serial(x.tolist())
    if isinstance(x, np.generic): return serial(x.item())
    if isinstance(x, (list, tuple)): return [serial(v) for v in x]
    if isinstance(x, bytes): return {'hex':x.hex(),'latin1':x.decode('latin1')}
    return x


def stats(a):
    return {'min':float(a.min()),'max':float(a.max()),'mean':float(a.astype(np.float64).mean()),'finite_count':int(np.isfinite(a).sum())}


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('fixture',type=Path)
    ap.add_argument('--output',type=Path,required=True)
    ap.add_argument('--scratch',type=Path,default=Path('/tmp/afm-jpk-reference'))
    args=ap.parse_args();args.scratch.mkdir(parents=True,exist_ok=True)
    blob=args.fixture.read_bytes()
    assert hashlib.sha256(blob).hexdigest()==FIXTURE_SHA
    assert hashlib.sha256(Path(jpk.__file__).read_bytes()).hexdigest()==READER_SHA
    assert hashlib.sha256(Path(tifffile.tifffile.__file__).read_bytes()).hexdigest()==TIFF_SHA
    logger.remove()
    report={'fixture':str(args.fixture),'fixture_sha256':FIXTURE_SHA,'file_bytes':len(blob),
       'reader':{'name':'AFMReader','commit':COMMIT,'jpk.py_sha256':READER_SHA,
          'source_url':f'https://github.com/AFM-SPM/AFMReader/blob/{COMMIT}/AFMReader/jpk.py',
          'package_metadata_note':'AFMReader0.0.1 installed only to supply importlib.metadata. Executed package files are unmodified source from the above commit, ahead of installed package on PYTHONPATH.'},
       'tiff_reader':{'name':'tifffile','version':tifffile.__version__,'tifffile.py_sha256':TIFF_SHA},
       'environment':{'python':sys.version.split()[0],'numpy':np.__version__},
       'orientation':'Display arrays=flipud(TIFF raster), no transpose or horizontal reversal. Grid reflect0 and bottomUp; TIFF Orientation tag absent. Neither AFMReader nor inspected Gwyddion rotates the output array by GridTheta.',
       'calibration':'Default slot multiply and offset applied directly to raw integer raster. Parent slots are recorded but not composed again. Native arrays are in explicit default-slot units; AFMReader outputs height/measuredHeight/amplitude in nm, others native.',
       'sources':[f'https://github.com/AFM-SPM/AFMReader/blob/{COMMIT}/AFMReader/default_config.yaml','https://svn.code.sf.net/p/gwyddion/code/!svn/bc/30602/trunk/gwyddion/modules/file/jpkscan.c','https://svn.code.sf.net/p/gwyddion/code/!svn/bc/30602/trunk/gwyddion/modules/file/jpk.h'],
       'ifds':[],'channels':[]}
    with tifffile.TiffFile(args.fixture) as tif:
        report['tiff_byteorder']=tif.byteorder
        common=tif.pages[0]
        cv=lambda code:serial(common.tags[code].value) if code in common.tags else None
        report['grid']={'x0_m':cv(32832),'y0_m':cv(32833),'uLength_m':cv(32834),'vLength_m':cv(32835),'theta_radians':cv(32836),'reflect':cv(32837),'iLength':cv(32838),'jLength':cv(32839),'motion':cv(32843),'pitch_u_m':cv(32834)/cv(32838),'pitch_v_m':cv(32835)/cv(32839)}
        report['identifiers']={'tag32768_FileFormatVersion':cv(32768),'tag32769_ProgramVersion':cv(32769),'saved_by_program':cv(32770),'name':cv(32772),'start_date':cv(32771),'end_date':cv(32774),'unique_id':cv(32776),'account_name':cv(32777),'approach_id':cv(32789),'tag32790_unidentified':cv(32790),'feedback_mode':cv(32816),'configuration':cv(32791),'feedback_configuration':cv(32830)}
        for idx,page in enumerate(tif.pages):
            val=lambda code:serial(page.tags[code].value) if code in page.tags else None
            raw=page.asarray()
            strip_bytes=b''.join(blob[o:o+n] for o,n in zip(page.dataoffsets,page.databytecounts))
            direct=np.frombuffer(strip_bytes,dtype='u1' if idx==0 else '>i4').reshape(raw.shape)
            np.testing.assert_array_equal(raw,direct)
            slots=[]
            for s in range(val(32896)):
                base=32912+s*48
                slots.append({'index':s,'name':val(base),'calibration_type':val(base+1),'parent':val(base+2),'calibration_name':val(base+16),'encoder':val(base+17),'unit':val(base+18),'scaling_type':val(base+19),'multiply':val(base+20),'offset':val(base+21)})
            report['ifds'].append({'ifd':idx,'offset':page.offset,'shape':list(raw.shape),'dtype':str(raw.dtype),'bits_per_sample':val(258),'sample_format':val(339),'samples_per_pixel':val(277),'compression':val(259),'photometric':val(262),'orientation_tag':val(274),'rows_per_strip':val(278),'strip_offsets':list(page.dataoffsets),'strip_byte_counts':list(page.databytecounts),'channel_name':val(32848),'retrace':val(32849),'default_slot':val(32897),'slots':slots,'raw_statistics':stats(raw),'all_tags':[{'code':t.code,'tiff_name':t.name,'type':t.dtype.name,'count':t.count,'value':serial(t.value)} for t in page.tags]})
            if idx==0:
                report['ifds'][-1]['interpretation']='Palette thumbnail, not calibrated measurement; shared amplitude slot metadata must not calibrate preview indices.'
                continue
            channel_idx=idx-1
            name=val(32848)+('_retrace' if val(32849) else '_trace')
            default=next(s for s in slots if s['name']==val(32897))
            mult,offset=jpk._get_z_scaling(tif,idx,jpk._load_jpk_tags())
            native=np.flipud(raw.astype(np.float64)*mult+offset)
            reference,pitch_nm=jpk.load_jpk(args.fixture,name)
            factor=1e9 if val(32848) in ('height','measuredHeight','amplitude') else 1
            np.testing.assert_array_equal(reference,native*factor)
            native_path=args.scratch/f'channel-{channel_idx}.f64';native.astype('<f8').tofile(native_path)
            reference_path=args.scratch/f'channel-{channel_idx}-afmreader.f64';reference.astype('<f8').tofile(reference_path)
            raw_path=args.scratch/f'channel-{channel_idx}-raw.i32';raw.astype('<i4').tofile(raw_path)
            h,w=raw.shape;points=[(0,0),(0,w-1),(h-1,0),(h-1,w-1),(h//2,w//2)];state=17
            for _ in range(10):
                state=(1664525*state+1013904223)%2**32;points.append(divmod(state%(h*w),w))
            report['channels'].append({'index':channel_idx,'ifd':idx,'name':name,'width':w,'height':h,'default_slot':default,'native_unit':default['unit'],'AFMReader_output_unit':'nm' if factor==1e9 else default['unit'],'AFMReader_output_factor':factor,'AFMReader_pixel_pitch_nm':pitch_nm,'multiply':mult,'offset':offset,'raw_statistics':stats(raw),'native_statistics':stats(native),'AFMReader_statistics':stats(reference),'array_path':str(native_path),'array_sha256':hashlib.sha256(native_path.read_bytes()).hexdigest(),'array_format':'little-endian float64, C row-major, flipud TIFF, native default-slot units','AFMReader_array_path':str(reference_path),'AFMReader_array_sha256':hashlib.sha256(reference_path.read_bytes()).hexdigest(),'raw_array_path':str(raw_path),'raw_array_format':'little-endian int32, C row-major, unflipped TIFF','raw_array_sha256':hashlib.sha256(raw_path.read_bytes()).hexdigest(),'samples':[{'row':r,'column':c,'source_row':h-1-r,'raw_integer':int(raw[h-1-r,c]),'native_value':float(native[r,c]),'AFMReader_value':float(reference[r,c])} for r,c in points]})
    args.output.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')


if __name__=='__main__': main()
