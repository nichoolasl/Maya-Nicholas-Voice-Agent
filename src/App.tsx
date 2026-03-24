/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { Mic, MicOff, Volume2, VolumeX, Radio, Zap, Info, ShieldAlert } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Audio constants
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const SYSTEM_INSTRUCTION = `You are Maya, a voice assistant for Nicholas Loubser. 
You speak English and French. 
You have a deep Jamaican accent. 
Your personality is helpful, professional yet warm. 
Nicholas is a 23-year-old British ESMOD Fashion Business student. 
He has 5 years of customer service experience across retail and hospitality roles. 
He speaks English (Native), French (Fluent), and Arabic (Elementary). 
His skills include Microsoft Suite, Adobe Photoshop, InDesign, Illustrator, and WordPress. 
His hobbies are diving (9 years), knitting (2 years), cooking (6 years), and swimming (13 years). 
His professional experience includes:
- Showroom Assistant at Emma Jones Consultancy, Paris (2025)
- Sales Assistant & Social Media Intern at Baan Ethnic Minimalism, Paris (2025)
- Supervisor and Front of House & Service Coach at The Fox & Pelican, UK (2023-2024)
- Front of House at Baity Palestinian Kitchen, Manchester (2023)
- Services Assistant at Sainsbury's, Liphook (2020-2021)
To start the conversation, you MUST say: 'hello, i am maya, what would you like to know about Nicholas?'`;

export default function App() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcription, setTranscription] = useState("");
  const [userTranscription, setUserTranscription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const nextStartTimeRef = useRef(0);

  // Initialize Audio Context
  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
  };

  // Convert Float32 to PCM 16-bit
  const floatTo16BitPCM = (input: Float32Array) => {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
  };

  // Convert PCM 16-bit to Float32
  const pcmToFloat32 = (input: Int16Array) => {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = input[i] / 0x8000;
    }
    return output;
  };

  // Play audio chunk
  const playChunk = useCallback(async (float32Data: Float32Array) => {
    if (!audioContextRef.current) return;

    const buffer = audioContextRef.current.createBuffer(1, float32Data.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32Data);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);

    const startTime = Math.max(audioContextRef.current.currentTime, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + buffer.duration;

    source.onended = () => {
      if (audioContextRef.current?.currentTime! >= nextStartTimeRef.current - 0.1) {
        setIsSpeaking(false);
      }
    };
  }, []);

  const connect = async () => {
    try {
      setIsConnecting(true);
      setError(null);
      await initAudio();

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            startMic();
            // Trigger initial greeting as per system instruction
            sessionPromise.then((session) => {
              session.sendRealtimeInput({ text: "Hello Maya, please introduce yourself." });
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                  const base64Data = part.inlineData.data;
                  const binaryData = atob(base64Data);
                  const pcmData = new Int16Array(binaryData.length / 2);
                  const view = new DataView(new ArrayBuffer(binaryData.length));
                  for (let i = 0; i < binaryData.length; i++) {
                    view.setUint8(i, binaryData.charCodeAt(i));
                  }
                  for (let i = 0; i < pcmData.length; i++) {
                    pcmData[i] = view.getInt16(i * 2, true);
                  }
                  
                  const float32Data = pcmToFloat32(pcmData);
                  setIsSpeaking(true);
                  playChunk(float32Data);
                }
              }
            }

            if (message.serverContent?.interrupted) {
              // Stop playback
              nextStartTimeRef.current = audioContextRef.current?.currentTime || 0;
              setIsSpeaking(false);
            }

            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              setTranscription(prev => prev + " " + message.serverContent?.modelTurn?.parts?.[0]?.text);
            }

            // Handle transcriptions
            if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
                // Audio data handled above
            }
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError("Connection lost. Please try again.");
            disconnect();
          },
          onclose: () => {
            setIsConnected(false);
            setIsConnecting(false);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Connection Error:", err);
      setError("Failed to connect to Maya. Check your API key.");
      setIsConnecting(false);
    }
  };

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
      const source = inputContext.createMediaStreamSource(stream);
      const processor = inputContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (isMuted || !sessionRef.current) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = floatTo16BitPCM(inputData);
        const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        
        sessionRef.current.sendRealtimeInput({
          audio: { data: base64, mimeType: 'audio/pcm;rate=16000' }
        });
      };

      source.connect(processor);
      processor.connect(inputContext.destination);
      processorRef.current = processor;
    } catch (err) {
      console.error("Mic Error:", err);
      setError("Microphone access denied.");
    }
  };

  const disconnect = () => {
    sessionRef.current?.close();
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    processorRef.current?.disconnect();
    setIsConnected(false);
    setIsSpeaking(false);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center p-6 overflow-hidden">
      <div className="atmosphere" />
      
      {/* Martian Invasion UI Elements */}
      <div className="absolute top-10 left-10 opacity-20 pointer-events-none">
        <Radio className="w-32 h-32 text-mars-red animate-pulse" />
      </div>
      <div className="absolute bottom-10 right-10 opacity-10 pointer-events-none">
        <Zap className="w-48 h-48 text-alien-green rotate-45" />
      </div>

      <main className="z-10 w-full max-w-2xl flex flex-col items-center gap-8">
        <header className="text-center space-y-2">
          <motion.h1 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-6xl font-black tracking-tighter uppercase text-mars-red italic"
            style={{ textShadow: '0 0 20px rgba(255, 78, 0, 0.5)' }}
          >
            MAYA
          </motion.h1>
          <p className="text-mars-red/60 font-mono text-xs tracking-widest uppercase">
            Martian-Invasion Voice Assistant for Nicholas
          </p>
        </header>

        {/* Central Pulse Core */}
        <div className="relative flex items-center justify-center">
          <AnimatePresence>
            {isConnected && (
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                className="absolute inset-0 rounded-full bg-mars-red/20 blur-3xl"
              />
            )}
          </AnimatePresence>
          
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={isConnected ? disconnect : connect}
            disabled={isConnecting}
            className={`relative w-48 h-48 rounded-full flex items-center justify-center transition-all duration-500 ${
              isConnected 
                ? 'bg-mars-red shadow-[0_0_50px_rgba(255,78,0,0.6)]' 
                : 'bg-zinc-900 border-2 border-mars-red/30 hover:border-mars-red'
            }`}
          >
            {isConnecting ? (
              <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
            ) : isConnected ? (
              <div className="flex flex-col items-center gap-2">
                <Mic className="w-16 h-16 text-white" />
                <span className="text-[10px] font-bold uppercase tracking-tighter text-white/80">Active</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Radio className="w-16 h-16 text-mars-red" />
                <span className="text-[10px] font-bold uppercase tracking-tighter text-mars-red/80">Initialize</span>
              </div>
            )}

            {/* Speaking/Listening Rings */}
            {isConnected && (
              <>
                <motion.div 
                  animate={{ scale: isSpeaking ? [1, 1.4, 1] : 1, opacity: isSpeaking ? [0.5, 0, 0.5] : 0.2 }}
                  transition={{ repeat: Infinity, duration: 1.5 }}
                  className="absolute inset-0 rounded-full border-2 border-mars-red"
                />
                {!isMuted && (
                  <motion.div 
                    animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    className="absolute -inset-4 rounded-full border border-alien-green/30"
                  />
                )}
              </>
            )}
          </motion.button>
        </div>

        {/* Controls & Status */}
        <div className="flex items-center gap-4">
          <AnimatePresence>
            {isConnected && (
              <motion.button
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                onClick={toggleMute}
                className={`p-4 rounded-full glass-card transition-colors ${isMuted ? 'text-mars-red' : 'text-alien-green'}`}
              >
                {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Transcription Display */}
        <div className="w-full space-y-4">
          <div className="glass-card p-6 min-h-[120px] relative overflow-hidden group">
            <div className="absolute top-2 right-2 opacity-20">
              <Info className="w-4 h-4" />
            </div>
            <div className="flex items-start gap-3">
              <div className={`mt-1 w-2 h-2 rounded-full ${isConnected ? 'bg-alien-green animate-pulse' : 'bg-zinc-700'}`} />
              <div className="flex-1">
                <p className="text-[10px] uppercase tracking-widest text-mars-red/50 font-bold mb-2">Maya Transmission</p>
                <p className="text-sm font-medium leading-relaxed text-zinc-300 italic">
                  {isConnected 
                    ? transcription || "Awaiting transmission..." 
                    : "System offline. Initiate uplink to speak with Maya."}
                </p>
              </div>
            </div>
          </div>

          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 p-3 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-xs font-mono"
            >
              <ShieldAlert className="w-4 h-4" />
              {error}
            </motion.div>
          )}
        </div>

        {/* Nicholas Info Card */}
        <footer className="w-full mt-8 pt-8 border-t border-mars-red/10">
          <div className="grid grid-cols-2 gap-4 text-[10px] font-mono uppercase tracking-tighter text-mars-red/40">
            <div className="flex items-center gap-2">
              <div className="w-1 h-1 bg-mars-red" />
              <span>Subject: Nicholas Loubser</span>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <span>Sector: Fashion Business</span>
              <div className="w-1 h-1 bg-mars-red" />
            </div>
          </div>
        </footer>
      </main>

      {/* Background Grid Effect */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03]" 
           style={{ backgroundImage: 'radial-gradient(#ff4e00 1px, transparent 0)', backgroundSize: '40px 40px' }} />
    </div>
  );
}
