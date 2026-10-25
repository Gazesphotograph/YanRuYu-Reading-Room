// Optional local ambience: no downloaded media, worker, animation loop or timer.
export class RoomAmbientSound {
  constructor({onStatus=()=>{},environment=globalThis}={}) {
    this.environment=environment;this.onStatus=onStatus;this.options={kind:'off',volume:20,duringReading:false};
    this.context=null;this.source=null;this.gain=null;this.filter=null;this.readerOpen=false;this.unlocked=false;this.disposed=false;this.focused=true;this.error='';this.queue=Promise.resolve();
    this.abort=new AbortController();
    const signal=this.abort.signal;
    environment.document?.addEventListener('visibilitychange',()=>this.sync(),{signal});
    environment.addEventListener?.('blur',()=>{this.focused=false;this.sync();},{signal});
    environment.addEventListener?.('focus',()=>{this.focused=true;this.sync();},{signal});
    environment.addEventListener?.('pagehide',()=>this.dispose(),{signal});
  }
  canPlay() {return !this.disposed&&this.unlocked&&this.options.kind!=='off'&&this.options.volume>0&&this.focused&&!this.environment.document?.hidden&&(!this.readerOpen||this.options.duringReading);}
  status() {
    if(this.error)return this.error;
    if(this.options.kind==='off')return '环境音已关闭';
    if(!this.unlocked)return '已记住声音偏好；点击播放即可开启';
    if(!this.options.volume)return '音量为零';
    if(this.environment.document?.hidden||!this.focused)return '窗口在后台，环境音已暂停';
    if(this.readerOpen&&!this.options.duringReading)return '阅读时已暂停环境音';
    return this.context?.state==='running'?'正在播放'+(this.options.kind==='rain'?'轻雨声':'微风声'):'环境音已暂停';
  }
  configure(options,{userGesture=false}={}) {
    this.options={kind:['rain','breeze'].includes(options?.kind)?options.kind:'off',volume:Math.max(0,Math.min(40,Number(options?.volume)||0)),duringReading:options?.duringReading===true};
    if(this.disposed)return Promise.resolve();
    if(userGesture&&this.options.kind!=='off'){
      const AudioContext=this.environment.AudioContext||this.environment.webkitAudioContext;
      if(!AudioContext){this.error='当前设备不支持环境音';this.onStatus(this.status());return Promise.resolve();}
      try {
        this.context??=new AudioContext();this.unlocked=true;this.error='';
        // Resume in the initiating user gesture to satisfy browser audio policy.
        const resumed=this.context.resume();
        resumed?.catch(error=>{this.error='环境音未能播放：'+(error?.message||'请重试');this.onStatus(this.status());});
      } catch(error) {this.error='环境音未能播放：'+(error?.message||'请重试');this.onStatus(this.status());return Promise.resolve();}
    }
    return this.sync();
  }
  createSource() {
    this.stopSource();
    const context=this.context,samples=Math.max(1,Math.round(context.sampleRate*3)),buffer=context.createBuffer(1,samples,context.sampleRate),data=buffer.getChannelData(0);
    let last=0;
    for(let index=0;index<samples;index++){
      const white=Math.random()*2-1;
      if(this.options.kind==='breeze'){last=(last+.02*white)/1.02;data[index]=last*2.8;}
      else data[index]=white*.4;
    }
    // A brief blend removes a possible discontinuity at the loop boundary.
    const fade=Math.min(128,Math.floor(samples/2));
    for(let index=0;index<fade;index++){const blend=index/fade;data[samples-fade+index]=data[samples-fade+index]*(1-blend)+data[index]*blend;}
    this.source=context.createBufferSource();this.source.buffer=buffer;this.source.loop=true;
    this.filter=context.createBiquadFilter();this.filter.type='lowpass';this.filter.frequency.value=this.options.kind==='rain'?2400:550;
    this.gain=context.createGain();this.gain.gain.value=this.options.volume/40*.22;
    this.source.connect(this.filter);this.filter.connect(this.gain);this.gain.connect(context.destination);this.source.start();this.sourceKind=this.options.kind;
  }
  stopSource() {
    try {this.source?.stop();} catch {}
    this.source?.disconnect();this.filter?.disconnect();this.gain?.disconnect();this.source=null;this.filter=null;this.gain=null;this.sourceKind=null;
  }
  sync() {
    this.queue=this.queue.catch(()=>{}).then(async()=>{
      if(this.disposed||!this.context){this.onStatus(this.status());return;}
      try {
        if(this.options.kind==='off'){this.stopSource();await this.context.suspend();}
        else if(this.canPlay()){
          if(this.sourceKind!==this.options.kind)this.createSource();
          if(this.gain)this.gain.gain.setTargetAtTime(this.options.volume/40*.22,this.context.currentTime,.08);
          await this.context.resume();
          // State may have changed while resume was pending.
          if(!this.canPlay())await this.context.suspend();
        } else await this.context.suspend();
        this.error='';
      } catch(error) {if(!this.disposed)this.error='环境音未能播放：'+(error?.message||'请重试');}
      this.onStatus(this.status());
    });
    return this.queue;
  }
  setReaderOpen(value) {this.readerOpen=!!value;return this.sync();}
  dispose() {
    if(this.disposed)return;
    this.disposed=true;this.abort.abort();this.stopSource();
    const context=this.context;this.context=null;context?.close().catch(()=>{});
  }
}
