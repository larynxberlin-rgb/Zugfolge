"""Authorized technical extraction, grid reduction and packing. No motifs drawn."""
from PIL import Image,ImageDraw
from pathlib import Path
import argparse,hashlib,json,io
import numpy as np

root=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check',action='store_true',help='Verify exact prepared bytes without writing files')
check=parser.parse_args().check
sheet=Image.new('RGBA',(6*32,12*40),(0,0,0,0))
proof={'schemaVersion':'offline-sprite-preparation/v2','technicalOnly':True,'frames':[],'sources':[]}
for filename,rows,offset in [('characters-source.png',8,0),('idle-source.png',4,8)]:
    path=root/filename
    raw=Image.open(path).convert('RGBA')
    a=np.array(raw)
    if filename.startswith('idle'):
        # Remove only edge-connected near-white checkerboard, preserving enclosed shirt/eye pixels.
        allowed=(a[:,:,:3].min(axis=2)>210)&((a[:,:,:3].max(axis=2)-a[:,:,:3].min(axis=2))<30)
        mask=Image.fromarray(allowed.astype('uint8')*255).copy()
        ImageDraw.floodfill(mask,(0,0),128)
        bg=np.array(mask)==128
        a[bg,3]=0
    a[:,:,3]=np.where(a[:,:,3]>127,255,0)
    raw=Image.fromarray(a)
    occupancy=(a[:,:,3]>0).sum(axis=1)
    occupied=occupancy>12
    runs=[];start=None
    for y,on in enumerate(occupied.tolist()+[False]):
        if on and start is None:start=y
        if not on and start is not None:
            if y-start>25:runs.append([start,y])
            start=None
    if len(runs)!=rows:raise ValueError((filename,'row extraction',runs))
    for row,(top,bottom) in enumerate(runs):
        for col in range(6):
            left=round(col*raw.width/6);right=round((col+1)*raw.width/6)
            cell=raw.crop((left,max(0,top-2),right,min(raw.height,bottom+2)))
            box=cell.getbbox()
            if not box:raise ValueError('Missing full character')
            crop=cell.crop(box)
            # Shared logical standing height, seated bodies naturally shorter.
            maxh=32 if offset+row<10 else 27
            scale=min(26/crop.width,maxh/crop.height)
            size=(max(1,round(crop.width*scale)),max(1,round(crop.height*scale)))
            small=crop.resize(size,Image.Resampling.NEAREST)
            pixels=np.array(small);pixels[:,:,3]=np.where(pixels[:,:,3]>127,255,0);small=Image.fromarray(pixels)
            x=col*32+(32-size[0])//2;y=(offset+row)*40+37-size[1]
            sheet.alpha_composite(small,(x,y))
            proof['frames'].append({'column':col,'row':offset+row,'sourceRect':[left+box[0],max(0,top-2)+box[1],box[2]-box[0],box[3]-box[1]],'logicalSize':size})
    proof['sources'].append({'file':filename,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'rowBands':runs})
buffer=io.BytesIO();sheet.save(buffer,format='PNG',optimize=True);output=buffer.getvalue()
proof['output']={'file':'characters.png','size':sheet.size,'sha256':hashlib.sha256(output).hexdigest()}
document=json.dumps(proof,indent=2)+'\n'
if check:
    if (root/'characters.png').read_bytes()!=output:raise ValueError('Prepared character PNG differs')
    if (root/'preparation.json').read_bytes()!=document.encode('utf-8'):raise ValueError('Character preparation evidence differs')
else:
    (root/'characters.png').write_bytes(output)
    (root/'preparation.json').write_text(document,encoding='utf-8',newline='\n')
print(json.dumps(proof['output']))
