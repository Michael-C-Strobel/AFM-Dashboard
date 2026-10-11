#!/usr/bin/env python3
"""Generate fixture-specific IBW evidence with external pinned igor2 0.5.12."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import numpy as np
from igor2 import binarywave

FIXTURE_SHA = '5dddfebc5ba226c5e8cb4aaa93d985b5067b747e9b8b0ace068bc1d4a5583b97'
READER_SHA = '26edce79f3acc46592607cf53095240e0bb0bdcb23dd1588f25b64103ab9fde4'
WHEEL_SHA = '1d99b30a3b82710578aafb21fbe02572c59f77ad4daba6d13a952115d200bac6'


def serial(value):
    if isinstance(value, np.ndarray):
        return serial(value.tolist())
    if isinstance(value, np.generic):
        return serial(value.item())
    if isinstance(value, bytes):
        return {'latin1': value.decode('latin1'), 'hex': value.hex()}
    if isinstance(value, dict):
        return {k: serial(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serial(v) for v in value]
    return value


def stats(array):
    finite = array[np.isfinite(array)].astype(np.float64)
    return {'min': float(finite.min()), 'max': float(finite.max()), 'mean': float(finite.mean()),
            'finite_count': int(finite.size), 'nan_count': int(np.isnan(array).sum()),
            'infinite_count': int(np.isinf(array).sum())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixture', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--scratch', type=Path, default=Path('/tmp/afm-ibw-reference'))
    args = parser.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)
    blob = args.fixture.read_bytes()
    assert hashlib.sha256(blob).hexdigest() == FIXTURE_SHA
    assert hashlib.sha256(Path(binarywave.__file__).read_bytes()).hexdigest() == READER_SHA
    scan = binarywave.load(args.fixture)
    wave = scan['wave']
    header, binheader, data = wave['wave_header'], wave['bin_header'], wave['wData']
    direct = np.frombuffer(blob, dtype='<f4', offset=384, count=data.size).reshape(data.shape, order='F')
    np.testing.assert_array_equal(data, direct)
    checksum = sum(struct.unpack('<192H', blob[:384])) % 65536
    assert checksum == 0
    labels_offset = 384 + data.nbytes + binheader['formulaSize'] + binheader['noteSize']
    labels_offset += binheader['dataEUnitsSize'] + sum(binheader['dimEUnitsSize'])
    label_slots = [blob[labels_offset+i*32:labels_offset+(i+1)*32] for i in range(9)]
    notes = []
    for line in wave['note'].decode('latin1').split('\r'):
        key, sep, value = line.partition(':')
        notes.append({'key': key, 'value': value.strip(), 'has_colon': bool(sep)})
    result = {
        'fixture': str(args.fixture), 'fixture_sha256': FIXTURE_SHA, 'file_bytes': len(blob),
        'reader': {'name': 'igor2', 'version': '0.5.12', 'wheel_sha256': WHEEL_SHA,
                   'binarywave.py_sha256': READER_SHA, 'url': 'https://pypi.org/project/igor2/0.5.12/'},
        'environment': {'python': sys.version.split()[0], 'numpy': np.__version__},
        'version': int(scan['version']), 'storage_dtype': '<f4', 'data_offset': 384,
        'data_bytes': data.nbytes, 'shape': list(data.shape), 'storage_order': 'Fortran: dimension0 fastest, then dimension1, then channel',
        'header_checksum_uint16_sum_mod65536': checksum,
        'binary_header': serial(binheader), 'wave_header': serial(header),
        'igor2_labels': serial(wave['labels']), 'labels_offset': int(labels_offset),
        'label_slots': [{'index': i, 'hex': slot.hex(), 'c_string': slot.split(b'\0',1)[0].decode('latin1')} for i,slot in enumerate(label_slots)],
        'note_latin1': wave['note'].decode('latin1'), 'note_sha256': hashlib.sha256(wave['note']).hexdigest(),
        'note_fields_in_order': notes,
        'extended_data_units': serial(wave['data_units']), 'extended_dimension_units': serial(wave['dimension_units']),
        'trailing_offset': int(labels_offset+288), 'trailing_bytes': len(blob)-int(labels_offset+288),
        'footer_last_5_ascii': blob[-5:].decode('ascii'),
        'coordinate_evidence': {'formula': 'coordinate[d,index]=sfA[d]*index+sfB[d]',
             'header_pitch_m': [float(x) for x in header['sfA'][:2]],
             'header_first_to_last_span_m': [float(header['sfA'][i]*(data.shape[i]-1)) for i in range(2)],
             'pixel_cell_extent_m': [float(header['sfA'][i]*data.shape[i]) for i in range(2)],
             'note_FastScanSize_m': 8e-7, 'note_SlowScanSize_m': 8e-7,
             'AFMReader_note_pitch_nm': 800/512},
        'orientation': 'igor2 returns wave[x,y,channel]. channel-N.f64 is flipud(wave[:,:,N].T), unscaled, C row-major [display_row,x]. channel-N-wave-order.f64 is wave[:,:,N], C row-major [x,y], unscaled. No direction-dependent horizontal flip.',
        'AFMReader_source_behavior': 'Pinned AFMReader caeecf32ac5900f99c0dfee4b49d27ba4ca0fd77 source inspected, not executed: flipud(wData[:,:,channel].T * 1e9) for all channels; multiplication can retain float32 rounding. Pixel pitch derived from note SlowScanSize/shape[0]. This is not a valid universal nm conversion for voltage channels.',
        'gwyddion_unit_source': {'svn_revision': 27984, 'sha256': '9a587932d971374f2c5aed3a720b913688dd9758a5c89ed7ab9e9ad6f0320a43',
            'url':'https://svn.code.sf.net/p/gwyddion/code/!svn/bc/27984/trunk/gwyddion/modules/file/igorfile.c',
            'behavior':'Per canonical channel note <name>Unit overrides channel-title fallback; Height and ZSensor fallback m. This is a reader convention, not explicit fixture unit calibration.'},
        'channels': []}
    for i in range(data.shape[2]):
        raw = data[:,:,i].astype(np.float64)
        canonical = np.flipud(raw.T)
        path = args.scratch/f'channel-{i}.f64'
        canonical.astype('<f8').tofile(path)
        wave_path = args.scratch/f'channel-{i}-wave-order.f64'
        raw.astype('<f8').tofile(wave_path)
        h,w = canonical.shape
        points = [(0,0),(0,w-1),(h-1,0),(h-1,w-1),(h//2,w//2)]
        state=17
        for _ in range(10):
            state=(1664525*state+1013904223)%2**32
            points.append(divmod(state%(h*w),w))
        label = label_slots[i+1].split(b'\0',1)[0].decode('ascii')
        result['channels'].append({'index':i,'label_c_string':label,'label_igor2':wave['labels'][2][i+1].decode('ascii'),
           'storage_offset':384+i*512*512*4,'storage_bytes':512*512*4,
           'dimensions':{'width':w,'height':h}, 'statistics_unscaled':stats(raw),
           'fixture_explicit_unit':'V' if label.startswith('UserIn') else None,
           'gwyddion_fallback_unit':'m' if label.startswith(('Height','ZSensor')) else None,
           'array_path':str(path),'array_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
           'array_encoding':'little-endian float64, C row-major, transpose then vertical flip, no unit conversion',
           'wave_order_array_path':str(wave_path),'wave_order_array_sha256':hashlib.sha256(wave_path.read_bytes()).hexdigest(),
           'samples':[{'row':r,'column':c,'value':float(canonical[r,c]),'igor_x':c,'igor_y':h-1-r} for r,c in points]})
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False)+'\n')


if __name__ == '__main__':
    main()
