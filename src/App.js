import React, { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Box, Cylinder, OrbitControls, Grid, Text, Ring } from '@react-three/drei'
import Peer from 'peerjs'

const INITIAL_JOG = 0; 

// --- 音量解析 ---
function useAudioAnalyzer(isHost) {
  const analyzerRef = useRef({ l: 0, r: 0, inited: false });
  const [stream, setStream] = useState(null);
  useEffect(() => {
    if (!isHost) return; 
    const initAudio = async () => {
      if (analyzerRef.current.inited) return;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        setStream(s); 
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const source = ctx.createMediaStreamSource(s);
        const splitter = ctx.createChannelSplitter(2);
        const analyserL = ctx.createAnalyser();
        const analyserR = ctx.createAnalyser();
        analyserL.fftSize = 256; analyserR.fftSize = 256;
        source.connect(splitter);
        splitter.connect(analyserL, 0);
        splitter.connect(analyserR, 1);
        const dataL = new Uint8Array(analyserL.frequencyBinCount);
        const dataR = new Uint8Array(analyserR.frequencyBinCount);
        const update = () => {
          analyserL.getByteFrequencyData(dataL);
          analyserR.getByteFrequencyData(dataR);
          let avgL = 0, avgR = 0;
          for(let i=0; i<10; i++) { avgL += dataL[i]; avgR += dataR[i]; }
          analyzerRef.current.l = Math.min(1, (avgL / 10 / 255) * 1.2);
          analyzerRef.current.r = Math.min(1, (avgR / 10 / 255) * 1.2);
          requestAnimationFrame(update);
        };
        update();
        analyzerRef.current.inited = true;
      } catch (e) { console.error("Audio Error:", e); }
    };
    const handler = () => { initAudio(); window.removeEventListener('click', handler); };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [isHost]);
  return { analyzerRef, stream };
}

function RemoteAudio({ stream }) {
  const audioRef = useRef();
  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
      audioRef.current.play().catch(e => console.log("Playback failed:", e));
    }
  }, [stream]);
  return <audio ref={audioRef} style={{ display: 'none' }} />;
}

// --- 同期対応パーツ (useFrameでRefを監視) ---

function LevelMeter({ position, levelRef, channelSide }) {
  const segments = [{c:'#0f0',t:0.1},{c:'#0f0',t:0.3},{c:'#ff0',t:0.5},{c:'#ff0',t:0.7},{c:'#f00',t:0.9}];
  return (
    <group position={position}>
      <Box args={[0.08, 0.01, 1.1]} position={[0, -0.02, 0]}><meshStandardMaterial color="#050505" /></Box>
      {segments.map((seg, i) => (
        <MeterSegment key={i} index={i} color={seg.c} threshold={seg.t} levelRef={levelRef} channelSide={channelSide} />
      ))}
    </group>
  );
}
function MeterSegment({ index, color, threshold, levelRef, channelSide }) {
  const meshRef = useRef();
  const zPos = 0.4 - (index * 0.22); 
  useFrame(() => {
    const vol = channelSide === 'left' ? levelRef.current.l : levelRef.current.r;
    const isActive = vol > threshold;
    meshRef.current.material.emissiveIntensity = isActive ? 2.0 : 0.0;
    meshRef.current.material.color.set(isActive ? color : "#222");
    meshRef.current.material.emissive.set(isActive ? color : "#000");
  });
  return <Box ref={meshRef} args={[0.06, 0.01, 0.18]} position={[0, 0.01, zPos]}><meshStandardMaterial color="#222" /></Box>
}

function JogDeck({ position, color, deckId, hardwareRef }) {
  const meshRef = useRef();
  
  useFrame((state, delta) => {
    const d = hardwareRef.current[`deck${deckId}`];
    const now = Date.now();
    
    // ★ここを修正：判定時間を150msから80ms程度に短縮し、
    // かつ「離した瞬間」の計算を滑らかにつなぎます
    const isTouching = (now - d.lastJogTime < 10);

    if (isTouching) {
      // 手で回している時はMIDIの角度をそのまま反映
      meshRef.current.rotation.y = d.rotation;
    } else if (d.playing || d.cueDown) {
      // 離れた瞬間、今の角度から即座に自動回転を加算開始する
      const tempoMultiplier = 1 + ((d.pitch - 64) / 64) * 0.1;
      d.rotation += delta * 2.5 * tempoMultiplier;
      meshRef.current.rotation.y = d.rotation;
    } else {
      meshRef.current.rotation.y = d.rotation;
    }
  });

  return (
    <group position={position} ref={meshRef}>
      <Cylinder args={[1.6, 1.6, 0.2, 64]}><meshStandardMaterial color="#111" metalness={0.8} /></Cylinder>
      <Box args={[0.5, 0.1, 0.1]} position={[1.2, 0.1, 0]}><meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} /></Box>
    </group>
  );
}
function SyncKnob({ position, color, deckId, param, hardwareRef }) {
  const meshRef = useRef();
  useFrame(() => {
    const val = hardwareRef.current[`deck${deckId}`][param];
    meshRef.current.rotation.y = -((val / 127) * Math.PI * 1.5 - Math.PI * 0.75);
  });
  return (
    <group position={position}>
      <Cylinder args={[0.18, 0.18, 0.2, 32]}><meshStandardMaterial color={color}/></Cylinder>
      <group ref={meshRef}>
        <Box args={[0.03, 0.08, 0.1]} position={[0, 0.1, -0.1]}><meshStandardMaterial color="white"/></Box>
      </group>
    </group>
  );
}

function SyncFader({ position, deckId, hardwareRef, color }) {
  const meshRef = useRef();
  useFrame(() => {
    const val = hardwareRef.current[`deck${deckId}`].vol;
    meshRef.current.position.z = 1.8 - ((val / 127) * 1.2 - 0.6);
  });
  return (
    <Box ref={meshRef} position={[position[0], position[1], 1.8]} args={[0.25, 0.12, 0.4]}>
      <meshStandardMaterial color={color} />
    </Box>
  );
}

function SyncPitchFader({ position, deckId, hardwareRef, color }) {
  const meshRef = useRef();
  useFrame(() => {
    const val = hardwareRef.current[`deck${deckId}`].pitch;
    meshRef.current.position.z = ((val / 127) - 0.5) * 1.6;
  });
  return (
    <group position={position}>
      <Box args={[0.15, 0.02, 1.8]} position={[0, -0.05, 0]}><meshStandardMaterial color="#050505" /></Box>
      <Box args={[0.2, 0.03, 0.02]} position={[0, -0.04, 0]}><meshStandardMaterial color="#555" /></Box>
      <Box ref={meshRef} args={[0.2, 0.1, 0.3]} position={[0, 0, 0]}>
        <meshStandardMaterial color={color} />
        <Box args={[0.22, 0.02, 0.02]} position={[0, 0.06, 0]}><meshStandardMaterial color="white" /></Box>
      </Box>
    </group>
  );
}

function SyncXFader({ position, hardwareRef }) {
  const meshRef = useRef();
  useFrame(() => {
    const val = hardwareRef.current.xfade;
    meshRef.current.position.x = ((val / 127) - 0.5) * 1.5;
  });
  return (
    <Box ref={meshRef} position={[0, position[1], position[2]]} args={[0.4, 0.12, 0.15]}>
      <meshStandardMaterial color="white" />
    </Box>
  );
}

function DJButton({ position, label, color, deckId, type, hardwareRef }) {
  const meshRef = useRef();
  const ringRef = useRef();
  useFrame(() => {
    const isActive = hardwareRef.current[`deck${deckId}`][type];
    const intensity = isActive ? 1.5 : 0;
    meshRef.current.material.emissiveIntensity = intensity * 0.5;
    meshRef.current.material.color.set(isActive ? color : "#222");
    ringRef.current.material.emissiveIntensity = intensity;
    ringRef.current.material.color.set(isActive ? color : "#111");
  });
  return (
    <group position={position}>
      <Cylinder ref={meshRef} args={[0.25, 0.25, 0.1, 32]}><meshStandardMaterial color="#222" /></Cylinder>
      <Ring ref={ringRef} args={[0.28, 0.32, 32]} rotation={[-Math.PI/2, 0, 0]} position={[0, 0.06, 0]}><meshStandardMaterial color="#111" /></Ring>
      <Text position={[0, 0.12, 0]} rotation={[-Math.PI/2, 0, 0]} fontSize={0.12} color="white">{label}</Text>
    </group>
  );
}

// --- Main App ---
export default function App() {
  const hardware = useRef({
    deck1: { rotation: INITIAL_JOG, playing: false, cueDown: false, trim: 64, hi: 64, mid: 64, low: 64, filter: 64, vol: 0, pitch: 64, lastJogTime: 0 },
    deck2: { rotation: INITIAL_JOG, playing: false, cueDown: false, trim: 64, hi: 64, mid: 64, low: 64, filter: 64, vol: 0, pitch: 64, lastJogTime: 0 },
    xfade: 64, lastBtnTime: 0
  });

  const [role, setRole] = useState(null); 
  const [peerId, setPeerId] = useState(''); 
  const [targetId, setTargetId] = useState(''); 
  const [status, setStatus] = useState('Idle');
  const [remoteStream, setRemoteStream] = useState(null); 

  const { analyzerRef, stream: localAudioStream } = useAudioAnalyzer(role === 'host');
  const peerRef = useRef(null);
  const connectionsRef = useRef([]); 
  const remoteLevelRef = useRef({ l: 0, r: 0 });

  useEffect(() => {
    if (!role) return;
    const peer = new Peer();
    peerRef.current = peer;
    peer.on('open', (id) => {
      setPeerId(id);
      setStatus(role === 'host' ? 'Hosting: Waiting for connections...' : 'Guest: Ready to join');
    });

    if (role === 'host') {
      peer.on('connection', (conn) => {
        connectionsRef.current.push(conn);
        setStatus(`Connected to ${connectionsRef.current.length} guest(s)`);
        if (localAudioStream) peer.call(conn.peer, localAudioStream);
      });
    } else {
      peer.on('call', (call) => {
        call.answer();
        call.on('stream', (stream) => setRemoteStream(stream));
      });
      peer.on('connection', (conn) => {
          conn.on('data', (data) => {
            const { deck1, deck2, xfade, levels } = data;
            Object.assign(hardware.current.deck1, deck1);
            Object.assign(hardware.current.deck2, deck2);
            hardware.current.xfade = xfade;
            if (levels) { remoteLevelRef.current.l = levels.l; remoteLevelRef.current.r = levels.r; }
          });
      });
    }
    return () => peer.destroy();
  }, [role, localAudioStream]);

  const joinSession = () => {
    if (!peerRef.current || !targetId) return;
    setStatus('Connecting...');
    const conn = peerRef.current.connect(targetId);
    conn.on('open', () => {
        setStatus('Connected to Host!');
        conn.on('data', (data) => {
            const { deck1, deck2, xfade, levels } = data;
            Object.assign(hardware.current.deck1, deck1);
            Object.assign(hardware.current.deck2, deck2);
            hardware.current.xfade = xfade;
            if (levels) { remoteLevelRef.current.l = levels.l; remoteLevelRef.current.r = levels.r; }
        });
    });
  };

  useEffect(() => {
    if (role !== 'host') return;
    const interval = setInterval(() => {
      const conns = connectionsRef.current;
      if (conns.length > 0) {
        const payload = {
            deck1: hardware.current.deck1,
            deck2: hardware.current.deck2,
            xfade: hardware.current.xfade,
            levels: analyzerRef.current
        };
        conns.forEach(conn => { if(conn.open) conn.send(payload); });
      }
    }, 40); 
    return () => clearInterval(interval);
}, [role, analyzerRef]); // analyzerRef を追加
  useEffect(() => {
    if (role !== 'host') return;
    const onMIDIMessage = (m) => {
      const [s, d1, d2] = m.data;
      const h = hardware.current;
      const now = Date.now();
      if (d1 === 11 && d2 === 127) {
        if (now - h.lastBtnTime > 200) {
          const target = (s === 144) ? h.deck1 : h.deck2;
          target.playing = !target.playing;
          h.lastBtnTime = now;
        }
      }
      if (d1 === 12) {
        const target = (s === 144) ? h.deck1 : h.deck2;
        target.rotation = INITIAL_JOG; 
        if (d2 === 127) { target.playing = false; target.cueDown = true; } 
        else { target.cueDown = false; }
      }
      if (s === 176 || s === 177 || s === 182) {
        const d = (s === 176 || (s === 182 && d1 === 55)) ? h.deck1 : h.deck2;
        if (d1 === 33 || d1 === 34) { 
          const diff = d2 > 64 ? d2 - 128 : d2;
          d.rotation += diff * 0.00007;
          d.lastJogTime = Date.now();
        }
        else if (d1 === 19) d.vol = d2;
        else if (d1 === 31) h.xfade = d2;
        else if (d1 === 0) d.pitch = d2;
        else if (d1 === 23) h.deck1.filter = d2;
        else if (d1 === 24) h.deck2.filter = d2;
        else {
          const kMap = { 4:'trim', 7:'hi', 11:'mid', 15:'low' };
          if (kMap[d1]) d[kMap[d1]] = d2;
        }
      }
    };
    navigator.requestMIDIAccess().then(access => {
      for (let input of access.inputs.values()) input.onmidimessage = onMIDIMessage;
    });
  }, [role]);

  const activeLevelRef = role === 'host' ? analyzerRef : remoteLevelRef;

  if (!role) {
      return (
          <div style={{ width: '100vw', height: '100vh', background: '#111', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
              <h1>Virtual DJ System</h1>
              <div style={{ display: 'flex', gap: '20px' }}>
                  <button onClick={() => setRole('host')} style={{ padding: '20px', fontSize: '20px', cursor: 'pointer', background: '#00ccff', border: 'none', borderRadius: '8px' }}>HOST (DJ Mode)</button>
                  <button onClick={() => setRole('guest')} style={{ padding: '20px', fontSize: '20px', cursor: 'pointer', background: '#ffaa00', border: 'none', borderRadius: '8px' }}>GUEST (Listener Mode)</button>
              </div>
          </div>
      )
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#050505' }}>
      <div style={{ position: 'absolute', top: 10, left: 10, color: 'white', fontFamily: 'monospace', zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: '10px' }}>
          <div>Status: <span style={{ color: '#0f0' }}>{status}</span></div>
          {role === 'host' && (
              <div>My ID: <span style={{ color: 'cyan', fontWeight: 'bold' }}>{peerId}</span><br/><small>(Share this ID)</small></div>
          )}
          {role === 'guest' && (
              <div style={{ marginTop: '10px' }}>
                  <input placeholder="Enter Host ID" value={targetId} onChange={e => setTargetId(e.target.value)} style={{ marginRight: '5px' }} />
                  <button onClick={joinSession}>Join</button>
              </div>
          )}
      </div>

      {role === 'guest' && remoteStream && <RemoteAudio stream={remoteStream} />}

      <Canvas camera={{ position: [0, 8, 7] }}>
        <ambientLight intensity={0.5} /><pointLight position={[10, 10, 10]} />
        <Grid infiniteGrid sectionColor="#333" cellColor="#111" />
        <Box args={[10, 0.2, 5.0]} position={[0, -0.11, 0.5]}><meshStandardMaterial color="#111" /></Box>

        {/* Deck 1 */}
        <group position={[-3.2, 0, 0.5]}>
          <JogDeck deckId="1" color="cyan" hardwareRef={hardware} />
          <DJButton position={[-0.8, 0.05, 1.8]} label="CUE" color="#ffaa00" deckId="1" type="cueDown" hardwareRef={hardware} />
          <DJButton position={[-0.8, 0.05, 2.5]} label="▶/||" color="#00ff44" deckId="1" type="playing" hardwareRef={hardware} />
          <SyncPitchFader position={[1.8, 0.05, 0]} deckId="1" hardwareRef={hardware} color="cyan" />
        </group>

        {/* Deck 2 */}
        <group position={[3.2, 0, 0.5]}>
          <JogDeck deckId="2" color="orange" hardwareRef={hardware} />
          <DJButton position={[-0.8, 0.05, 1.8]} label="CUE" color="#ffaa00" deckId="2" type="cueDown" hardwareRef={hardware} />
          <DJButton position={[-0.8, 0.05, 2.5]} label="▶/||" color="#00ff44" deckId="2" type="playing" hardwareRef={hardware} />
          <SyncPitchFader position={[1.8, 0.05, 0]} deckId="2" hardwareRef={hardware} color="orange" />
        </group>

        {/* Mixer Deck 1 */}
        <group position={[-0.8, 0.05, 0]}>
          <SyncKnob position={[0,0,-1.5]} color="#f44" deckId="1" param="trim" hardwareRef={hardware} />
          <SyncKnob position={[0,0,-1.0]} color="#444" deckId="1" param="hi" hardwareRef={hardware} />
          <SyncKnob position={[0,0,-0.5]} color="#444" deckId="1" param="mid" hardwareRef={hardware} />
          <SyncKnob position={[0,0,0]}    color="#444" deckId="1" param="low" hardwareRef={hardware} />
          <SyncKnob position={[0,0,0.6]}  color="#44f" deckId="1" param="filter" hardwareRef={hardware} />
          <SyncFader position={[0, 0, 0]} deckId="1" hardwareRef={hardware} color="cyan" />
          <LevelMeter position={[0.35, 0, -0.6]} levelRef={activeLevelRef} channelSide="left" />
        </group>

        {/* Mixer Deck 2 */}
        <group position={[0.8, 0.05, 0]}>
          <SyncKnob position={[0,0,-1.5]} color="#f44" deckId="2" param="trim" hardwareRef={hardware} />
          <SyncKnob position={[0,0,-1.0]} color="#444" deckId="2" param="hi" hardwareRef={hardware} />
          <SyncKnob position={[0,0,-0.5]} color="#444" deckId="2" param="mid" hardwareRef={hardware} />
          <SyncKnob position={[0,0,0]}    color="#444" deckId="2" param="low" hardwareRef={hardware} />
          <SyncKnob position={[0,0,0.6]}  color="#44f" deckId="2" param="filter" hardwareRef={hardware} />
          <SyncFader position={[0, 0, 0]} deckId="2" hardwareRef={hardware} color="orange" />
          <LevelMeter position={[-0.35, 0, -0.6]} levelRef={activeLevelRef} channelSide="right" />
        </group>

        <SyncXFader position={[0, 0.05, 2.8]} hardwareRef={hardware} />
        <OrbitControls />
      </Canvas>
    </div>
  )
}