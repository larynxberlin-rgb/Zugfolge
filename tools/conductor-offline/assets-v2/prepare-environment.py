"""Technical crop, alpha threshold and nearest-neighbour grid preparation only."""
from PIL import Image
from pathlib import Path
import numpy as np,json,hashlib,argparse,io
root=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check',action='store_true',help='Verify exact prepared bytes without writing files')
check=parser.parse_args().check
source=root/'environment-source.png';im=Image.open(source).convert('RGBA');a=np.array(im)
a[:,:,3]=np.where(a[:,:,3]>127,255,0);im=Image.fromarray(a)
out=Image.new('RGBA',(192,128),(0,0,0,0));frames=[]
for row in range(2):
 for col in range(3):
  bounds=(col*512,row*512,(col+1)*512,(row+1)*512);cell=im.crop(bounds);box=cell.getbbox()
  if box is None:raise ValueError('Missing environment motif')
  crop=cell.crop(box);factor=min(60/crop.width,60/crop.height);size=(round(crop.width*factor),round(crop.height*factor))
  small=crop.resize(size,Image.Resampling.NEAREST);out.alpha_composite(small,(col*64+(64-size[0])//2,row*64+63-size[1]))
  frames.append({'row':row,'column':col,'sourceRect':[bounds[0]+box[0],bounds[1]+box[1],box[2]-box[0],box[3]-box[1]],'size':size})
buffer=io.BytesIO();out.save(buffer,format='PNG',optimize=True);output=buffer.getvalue()
report={'schemaVersion':'offline-environment-preparation/v2','technicalOnly':True,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'frames':frames,'outputSha256':hashlib.sha256(output).hexdigest()}
document=json.dumps(report,indent=2)+'\n'
if check:
 if (root/'environment.png').read_bytes()!=output:raise ValueError('Prepared environment PNG differs')
 if (root/'environment-preparation.json').read_bytes()!=document.encode('utf-8'):raise ValueError('Environment preparation evidence differs')
else:
 (root/'environment.png').write_bytes(output)
 (root/'environment-preparation.json').write_text(document,encoding='utf-8',newline='\n')
print(json.dumps(report))
