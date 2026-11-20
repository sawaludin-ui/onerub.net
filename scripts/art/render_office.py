"""Offline CPU ray-marched studio render. Dependencies: numpy, numba, pillow, scipy, imageio-ffmpeg."""
import math, subprocess, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy.ndimage import distance_transform_edt, gaussian_filter
from numba import njit, prange
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/sculpture'
OUT.mkdir(exist_ok=True)
N = 640
FRAMES = 144
TAU = math.tau
im = Image.open(ROOT/'app/icon.png').convert('L').resize((512,512))
mask = np.asarray(im) < 128
field = gaussian_filter(distance_transform_edt(~mask)-distance_transform_edt(mask), 2.0).astype(np.float32)/171
stamp = Image.new('L',(1400,160))
draw = ImageDraw.Draw(stamp)
font = ImageFont.truetype(str(ROOT/'public/reference/BarlowCondensed-Bold.ttf'),120)
for x,word in [(15,'ONERUB'),(720,'.ai')]:
    draw.text((x,0),word,font=font,fill=255)
ink = np.asarray(stamp)
rng = np.random.default_rng(317)
tex = np.zeros((1024,1024),np.float32)
for _ in range(29000):
    x,y = rng.integers(0,1024,2)
    size = rng.choice([1,1,1,2,2,3,4])
    tex[y:y+size,x:x+size] = rng.uniform(.04,.52)
tex = gaussian_filter(tex,.50)
@njit
def sdf(x,y):
    u=x*171+255.5
    v=255.5-y*171
    if u<0 or v<0 or u>=511 or v>=511:
        return max(abs(x),abs(y))-.99
    a,b=int(u),int(v)
    f,g=u-a,v-b
    return (1-g)*((1-f)*field[b,a]+f*field[b,a+1])+g*((1-f)*field[b+1,a]+f*field[b+1,a+1])
@njit
def dist(x,y,z,h,key):
    if key>=4:
        a=abs(x)-.207
        b=abs(y)-.37
        flat=min(max(a,b),0.)+math.hypot(max(a,0),max(b,0))
    else:
        flat=sdf(x,y)
    bevel=.021 if key<4 else .033
    a=flat+bevel
    b=abs(z)-h+bevel
    return min(max(a,b),0.)+math.hypot(max(a,0),max(b,0))-bevel
@njit
def hitpart(ox,oy,oz,dx,dy,dz,h,key):
    t=max(0.,(oz-h)/(-dz))
    end=(oz+h)/(-dz)
    while t<=end+.0025:
        x,y,z=ox+dx*t,oy+dy*t,oz+dz*t
        d=dist(x,y,z,h,key)
        if d<.00065:
            return t
        t+=max(.0007,d*.94)
    return 1e4
@njit(parallel=True)
def render(pose, N):
    out=np.empty((N,N,3),np.uint8)
    # Camera faces the sculpture from above and in front, orthographically.
    dz=-.54
    dy=.841665
    for i in prange(N):
        for j in range(N):
            sx=(j+.5-N*.5)*3.58/N
            sy=(N*.5-i-.5)*3.58/N
            ox=sx
            oy=-4*dy+sy*(-dz)
            oz=1.03-4*dz+sy*dy
            best=1e4
            winner=-1
            for k in range(len(pose)):
                px,py,pz,c,s,h,ct,st=pose[k]
                x,y=ox-px,oy-py
                lx,ly=c*x+s*y,-s*x+c*y
                lz=oz-pz
                t=hitpart(lx,ct*ly+st*lz,-st*ly+ct*lz,s*dy,ct*c*dy+st*dz,-st*c*dy+ct*dz,h,k)
                if t<best:
                    best,winner=t,k
            if winner<0:
                gy=oy+dy*oz/(-dz)
                shadow=math.exp(-((sx-.15)**2/.62+(gy-.14)**2/.66))*23
                shade=int(229-shadow)
                out[i,j]=shade
                continue
            k=winner
            px,py,pz,c,s,h,ct,st=pose[k]
            wx,wy,wz=ox,oy+dy*best,oz+dz*best
            lx,ly,lz=c*(wx-px)+s*(wy-py),-s*(wx-px)+c*(wy-py),wz-pz
            ly,lz=ct*ly+st*lz,-st*ly+ct*lz
            e=.002
            nx=dist(lx+e,ly,lz,h,k)-dist(lx-e,ly,lz,h,k)
            ny=dist(lx,ly+e,lz,h,k)-dist(lx,ly-e,lz,h,k)
            nz=dist(lx,ly,lz+e,h,k)-dist(lx,ly,lz-e,h,k)
            length=math.sqrt(nx*nx+ny*ny+nz*nz)+1e-8
            ny,nz=ct*ny-st*nz,st*ny+ct*nz
            nx,ny,nz=(nx*c-ny*s)/length,(nx*s+ny*c)/length,nz/length
            direct=max(0.,-.48*nx-.43*ny+.76*nz)
            light=.72+.32*direct+.07*nx+.025*nz
            # Nearby surfaces attenuate diffuse irradiance, preserving soft contact between the pieces.
            ao=1.
            qx,qy,qz=wx+.09*nx,wy+.09*ny,wz+.09*nz
            for m in range(4):
                if m==k: continue
                ax,ay,az,cc,ss,hh,_,_=pose[m]
                if abs(qz-az)>hh+.18: continue
                xx,yy=qx-ax,qy-ay
                dd=dist(cc*xx+ss*yy,-ss*xx+cc*yy,qz-az,hh,m)
                ao*=.69+.31*min(1.,max(0.,dd/.18))
            light*=ao
            radial=(nx*wx+ny*wy)/(math.hypot(wx,wy)+.0001)
            if k<4 and radial<0:
                light*=1.-min(1.,-radial)*(.12+.23*max(0.,min(1.,(1.75-wz)/1.3)))
            u,v=int((lx+.64*lz)*390)%1024,int((ly+.91*lz)*390)%1024
            grit=tex[v,u]
            r,g,b=234.,232.,226.
            if k==0:
                r,g,b=196.,197.,190.
            if k==1:
                grain=math.sin(67*lz+3*math.sin(5*lx+2*ly)+2*math.sin(4*ly))+ .48*math.sin(193*lz+9*math.sin(3*lx-ly))
                r,g,b=209+9*grain,177+11*grain,136+12*grain
            if k==2:
                r,g,b=38.,39.,37.
                # Screen print follows the circumference on the charcoal layer.
                a=(math.atan2(ly,lx)+math.pi*2.5)%TAU
                u=int(((a/TAU*4+.19)%1)*1400)
                v=int((.50-lz/(2*h))*220-25)
                if 0<=v<160 and abs(nz)<.5 and radial>.0:
                    w=ink[v,u]/255.
                    r,g,b=r+(228-r)*w,g+(228-g)*w,b+(218-b)*w
            if k>=4:
                if k==4:r,g,b=255.,224.,51.
                if k==5:r,g,b=133.,224.,126.
                if k==6:r,g,b=246.,130.,171.
            if k==0 or k==3:
                r*=1-grit*.82; g*=1-grit*.84; b*=1-grit*.79
                # Hairline joints divide the molded terrazzo crown into five stone segments.
                ang=math.atan2(ly,lx)
                seam=abs(math.sin(2.5*(ang+.32)))
                light*=.78+.22*min(1.,seam*95)
            else:
                light*=1-.075*grit
            spec=12*max(0.,-.27*nx-.65*ny+.70*nz)**14
            for ch,val in enumerate((r,g,b)):
                out[i,j,ch]=max(0,min(255,int(light*val+spec)))
    return out

def pose(t):
    a=TAU*t
    expand=(1-math.cos(a))/2
    base=.31+.21*math.sin(a)
    rows=[]
    for k,(z,h) in enumerate(((.145,.14),(.49,.20),(.92,.23),(1.43,.276))):
        angle=base+(k-1.5)*.18*expand
        rows.append((0,0,z+k*.11*expand,math.cos(angle),math.sin(angle),h,1.,0.))
    for k,(ang,z,rad) in enumerate(((1.22,.78,1.03),(-.79,.64,1.02),(3.02,1.56,.45))):
        ang+=base
        radius=rad+.16+.13*expand if k!=2 else rad+.03*expand
        tilt=(.50,-.56,-.70)[k]
        # Each insert is independently clocked around the pentagonal housing.
        rows.append((math.sin(ang)*radius,-math.cos(ang)*radius,z+.18*expand,math.cos(ang),math.sin(ang),.163,math.cos(tilt),math.sin(tilt)))
    return np.array(rows)
def encode_webm():
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
        '-y', '-i', str(OUT / 'office-loop.mp4'), '-map', '0:v:0', '-an',
        '-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-pix_fmt', 'yuv420p',
        '-row-mt', '1', '-cpu-used', '3', str(OUT / 'office-loop.webm'),
    ], check=True)

if __name__=='__main__':
    if '--webm-only' in sys.argv:
        encode_webm()
        sys.exit()
    poster=Image.fromarray(render(pose(0),1280)).resize((960,960),Image.Resampling.LANCZOS)
    frame=render(pose(0),N)
    poster.save(OUT/'office-poster.webp', quality=94)
    if '--poster' in sys.argv: sys.exit()
    args=[imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{N}x{N}','-r','24','-i','-','-an','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'office-loop.mp4')]
    proc=subprocess.Popen(args,stdin=subprocess.PIPE)
    for i in range(FRAMES):
        if i: frame=render(pose(i/FRAMES),N)
        proc.stdin.write(frame.tobytes())
        if i%24==0: print(i,flush=True)
    proc.stdin.close()
    if proc.wait():
        sys.exit(proc.returncode)
    encode_webm()
