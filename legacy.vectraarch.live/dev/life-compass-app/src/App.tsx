import React, { useState } from 'react';
import { 
  Search, 
  ChevronLeft, 
  ChevronRight, 
  Plus, 
  Calendar as CalIcon, 
  Sliders, 
  Wallet, 
  Dumbbell, 
  Utensils, 
  Heart, 
  User 
} from 'lucide-react';

const PROFILES = [
  { id: 'female', name: 'FEMALE KOEN', emoji: '👩', color: '#FF2A85', bg: '#FF2A8515', border: '#FF2A8560' },
  { id: 'girl', name: 'GIRL KOEN', emoji: '👧', color: '#00F2FE', bg: '#00F2FE15', border: '#00F2FE60' },
  { id: 'boy', name: 'BOY KOEN', emoji: '👦', color: '#00FF87', bg: '#00FF8715', border: '#00FF8760' },
  { id: 'male', name: 'MALE KOEN', emoji: '👨', color: '#2A85FF', bg: '#2A85FF15', border: '#2A85FF60' },
];

export default function App() {
  const [activeProfiles, setActiveProfiles] = useState(['female', 'girl', 'boy', 'male']);

  const toggleProfile = (id: string) => {
    setActiveProfiles(prev => 
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  return (
    <div className="min-h-screen bg-[#0B0B0E] text-[#E4E4E7] font-mono selection:bg-[#FF2A85]/30 flex flex-col uppercase">
      
      {/* GLOBAL HUD TOPBAR */}
      <header className="px-4 py-3 border-b border-[#27272A] flex justify-between items-center text-[10px] tracking-widest font-bold shrink-0 bg-[#0B0B0E]">
        <div className="flex items-center gap-2 text-[#4A4A5A]">
          <span className="text-[#FF2A85]">VECTRA ARCH</span>
          <span>//</span>
          <span>LEGACY</span>
          <span>//</span>
          <span className="text-white">CALENDAR</span>
        </div>
        <div className="text-[#4A4A5A] hidden sm:block">
          SECURE_NODE // 134.209.202.155
        </div>
      </header>

      <main className="flex-1 overflow-y-auto pb-24">
        {/* HEADER CONTROLS */}
        <div className="px-4 py-5 border-b border-[#27272A] bg-[#0B0B0E]">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div>
              <h1 className="text-3xl font-black text-white tracking-widest mb-1">CALENDAR</h1>
              <p className="text-[10px] text-[#4A4A5A] font-bold tracking-[0.2em]">
                EVENTS // DATA // SCHEDULING INTERFACE
              </p>
            </div>

            {/* MULTI-PROFILE TOGGLES */}
            <div className="flex flex-wrap gap-2">
              {PROFILES.map((p) => {
                const isActive = activeProfiles.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggleProfile(p.id)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded border transition-all"
                    style={{ 
                      borderColor: isActive ? p.border : '#27272A', 
                      backgroundColor: isActive ? p.bg : 'transparent',
                      color: isActive ? p.color : '#4A4A5A'
                    }}
                  >
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-xs" style={{ backgroundColor: isActive ? `${p.color}30` : '#1A1A24' }}>
                      {p.emoji}
                    </div>
                    <span className="text-[10px] font-bold tracking-widest">{p.name}</span>
                    {isActive && <span className="text-[8px] ml-0.5">●</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* CALENDAR MODULE (Matched to Image 1) */}
        <div className="max-w-4xl mx-auto p-4 space-y-5 mt-4">
          
          {/* Search Bar */}
          <div className="bg-[#111116] border border-[#27272A] rounded p-2.5 flex items-center gap-3">
            <Search size={16} className="text-[#4A4A5A]" />
            <input 
              type="text" 
              placeholder="Search events..." 
              className="bg-transparent border-none text-white text-xs w-full focus:outline-none font-mono normal-case placeholder-[#4A4A5A]" 
            />
          </div>

          {/* Month Navigator */}
          <div className="bg-[#111116] border border-[#27272A] rounded p-2.5 flex items-center justify-between">
            <ChevronLeft size={18} className="text-[#4A4A5A] cursor-pointer hover:text-white transition-colors" />
            <span className="text-white text-xs font-bold tracking-[0.25em]">MAY 2026</span>
            <ChevronRight size={18} className="text-[#4A4A5A] cursor-pointer hover:text-white transition-colors" />
          </div>

          {/* Grid Engine */}
          <div className="bg-[#111116] border border-[#27272A] rounded p-4">
            <div className="grid grid-cols-7 mb-3 text-center text-[10px] text-[#4A4A5A] font-bold tracking-widest">
              <div>MON</div><div>TUE</div><div>WED</div><div>THU</div><div>FRI</div><div>SAT</div><div>SUN</div>
            </div>
            
            <div className="grid grid-cols-7 gap-1.5">
              {Array.from({ length: 31 }).map((_, i) => {
                const dayNum = i + 1;
                const isToday = dayNum === 21;
                
                // Emulate exact exact dot patterns from your screenshot
                let indicators: string[] = [];
                if (dayNum === 6) indicators = [PROFILES[3].color, PROFILES[2].color, PROFILES[1].color];
                if (dayNum === 13) indicators = [PROFILES[0].color, PROFILES[1].color];
                if (dayNum === 20) indicators = [PROFILES[0].color, PROFILES[2].color, PROFILES[3].color];
                if (dayNum === 21) indicators = [PROFILES[0].color, PROFILES[1].color, PROFILES[2].color, PROFILES[3].color];

                return (
                  <div 
                    key={i} 
                    className={`h-14 rounded-sm p-1.5 flex flex-col justify-between transition-colors border ${
                      isToday 
                        ? 'bg-[#2A85FF]/10 border-[#2A85FF]' 
                        : 'bg-[#0B0B0E] border-[#27272A]'
                    }`}
                  >
                    <span className={`text-[10px] font-bold ${isToday ? 'text-[#2A85FF]' : 'text-[#71717A]'}`}>
                      {dayNum}
                    </span>
                    
                    {indicators.length > 0 && (
                      <div className="flex gap-0.5 w-full">
                        {indicators.map((color, idx) => (
                          <div key={idx} className="h-1 flex-1 rounded-sm" style={{ backgroundColor: color }} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Event Card Stream */}
          <div className="space-y-3">
            <div className="text-[10px] text-[#4A4A5A] font-bold tracking-[0.2em]">THURSDAY, 21 MAY 2026</div>
            
            <div className="bg-[#111116] border border-[#27272A] border-l-4 border-l-[#FF2A85] p-3.5 rounded flex justify-between items-center shadow-lg shadow-black/20">
              <div className="flex items-center gap-4">
                <div className="w-9 h-9 rounded-full bg-[#FF2A85]/10 border border-[#FF2A85]/30 flex items-center justify-center text-base shadow-[inset_0_0_10px_rgba(255,42,133,0.2)]">
                  👩
                </div>
                <div>
                  <div className="text-[9px] text-[#FF2A85] font-bold tracking-widest mb-1">EXPENSE // FAMILY DATA</div>
                  <div className="text-white text-xs font-bold tracking-wider">TEST (EXPENSE)</div>
                </div>
              </div>
              <div className="text-xs font-bold text-[#FF2A85] bg-[#FF2A85]/10 border border-[#FF2A85]/30 px-2.5 py-1.5 rounded tracking-wider shadow-[0_0_10px_rgba(255,42,133,0.1)]">
                R555.00
              </div>
            </div>
          </div>

          {/* System Action Button */}
          <button className="w-full bg-[#111116] border border-[#27272A] hover:bg-[#1A1A24] hover:text-white hover:border-[#4A4A5A] text-[#71717A] text-[10px] font-bold tracking-widest py-3.5 flex justify-center items-center gap-2 rounded transition-all">
            <Plus size={14} /> ADD SYSTEM EVENT
          </button>
        </div>
      </main>

      {/* CORE ACTION PERSISTENT DOCK */}
      <nav className="fixed bottom-0 left-0 right-0 bg-[#0B0B0E] border-t border-[#27272A] px-2 py-3 flex justify-around items-center z-50">
        {[
          { id: 'calendar', label: 'CAL', icon: CalIcon, color: '#FF2A85', active: true },
          { id: 'budget', label: 'BUD', icon: Sliders, color: '#4A4A5A', active: false },
          { id: 'finances', label: 'FIN', icon: Wallet, color: '#4A4A5A', active: false },
          { id: 'gym', label: 'GYM', icon: Dumbbell, color: '#4A4A5A', active: false },
          { id: 'meals', label: 'NUT', icon: Utensils, color: '#4A4A5A', active: false },
          { id: 'cycle', label: 'CYC', icon: Heart, color: '#4A4A5A', active: false },
          { id: 'profile', label: 'PRO', icon: User, color: '#4A4A5A', active: false },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className="flex flex-col items-center gap-1.5 flex-1 transition-colors">
              <Icon size={20} style={{ color: item.active ? item.color : '#4A4A5A' }} />
              <span className="text-[8px] font-bold tracking-widest" style={{ color: item.active ? item.color : '#4A4A5A' }}>
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
