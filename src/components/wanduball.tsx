"use client";
import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, CircleHelp, ClipboardList, Copy, Dices, ExternalLink, History, LayoutDashboard, LoaderCircle, LockKeyhole, LogIn, LogOut, Plus, Radio, RotateCcw, Settings2, ShieldAlert, Sparkles, Trophy, Users, Volume2, VolumeX, X, Zap, } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { commandSchema, currentAssignments, enabledPositions, GameState, isCurrent, nicknameMaxLength, Player, playerLabel, pool, pointsWheel, Position, positions, spinDurationMs, stateSchema, transition, type Command } from "@/lib/game";
import { initialState } from "@/lib/seed";
import { wheelColors } from "@/lib/wheel";
import { randomIndex, requestJson, supabase } from "@/lib/browser";
import { ThemePicker } from "@/components/theme-picker";
import { PlayerNicknameEditor } from "@/components/player-nickname-editor";
import { AutoWheel } from "@/components/auto-wheel";
import { RoomCommissioners } from "@/components/room-commissioners";
import { useRoomAccess } from "@/components/use-room-access";
import { SleeperAssignmentCell, useSleeperAssignments } from "@/components/sleeper-assignments";
import { liveAutoEnabled } from "@/lib/sleeper-auto";
import "./wheel-style.css";
type Tab = "clubhouse" | "setup" | "arena" | "assignments" | "rules" | "history";
type Room = {
    state: GameState;
    version: number;
    roomId?: string;
};
const storageKey = "wanduball-practice-v1";
const menu: {
    tab: Tab;
    label: string;
    icon: typeof Trophy;
}[] = [
    { tab: "clubhouse", label: "The clubhouse", icon: LayoutDashboard },
    { tab: "setup", label: "Weekly setup", icon: Settings2 },
    { tab: "arena", label: "The chaos room", icon: Dices },
    { tab: "assignments", label: "Player assignments", icon: ClipboardList },
    { tab: "rules", label: "Rules of nonsense", icon: ShieldAlert },
    { tab: "history", label: "The evidence locker", icon: History },
];
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
function Football() {
    return <figure className="wandu-mascot">
        <Image src="/wanduball-mascot.jpg" alt="Wanduball mascot: a fish with a cigarette wearing high-top sneakers" width={750} height={1000} sizes="(max-width: 650px) 230px, 300px" preload />
        <figcaption>THE PROCESS HAS A SUPERVISOR.</figcaption>
    </figure>;
}
function Pill({ children, tone = "" }: {
    children: React.ReactNode;
    tone?: string;
}) {
    return <span className={`pill ${tone}`}>{children}</span>;
}
const subscribeHydration = () => () => { };
const clientSnapshot = () => true;
const serverSnapshot = () => false;
function LoadingGame() {
    return <div className="loading-screen"><Dices size={36}/><h1>wanduball<span>.</span></h1><p>Warming up the bad idea machine...</p></div>;
}
export default function Wanduball() {
    return <Suspense fallback={<LoadingGame />}><HydratedGame /></Suspense>;
}
function HydratedGame() {
    const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
    const params = useSearchParams();
    const roomId = params.get("room");
    return hydrated ? <Game key={roomId ?? "practice"} roomId={roomId}/> : <LoadingGame />;
}
function loadPractice(roomId: string | null) {
    const fresh = initialState();
    if (roomId)
        return { state: { ...fresh, players: [], source: "Loading live room..." }, error: "" };
    try {
        const saved = localStorage.getItem(storageKey);
        return { state: saved ? stateSchema.parse(JSON.parse(saved)) : fresh, error: "" };
    }
    catch {
        return { state: fresh, error: "Saved practice data could not be read. Export any open copy before resetting practice." };
    }
}
function Game({ roomId }: {
    roomId: string | null;
}) {
    const router = useRouter();
    const [initial] = useState(() => loadPractice(roomId));
    const [game, setGame] = useState<GameState>(initial.state);
    const [storageBlocked, setStorageBlocked] = useState(Boolean(initial.error));
    const [tab, setTab] = useState<Tab>("clubhouse");
    const [position, setPosition] = useState<Position>("QB");
    const [ready, setReady] = useState(!roomId);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState(initial.error || (roomId && !supabase ? "This live room needs Supabase configuration. Open the site without ?room= to use practice mode." : ""));
    const [version, setVersion] = useState(0);
    const [session, setSession] = useState<Session | null>(null);
    const { access, refreshAccess, changeCommissioner } = useRoomAccess(roomId, session, setError);
    const [connected, setConnected] = useState(false);
    const [settings, setSettings] = useState(false);
    const [help, setHelp] = useState(false);
    const [muted, setMuted] = useState(true);
    const [now, setNow] = useState(Date.now);
    const [leagueId, setLeagueId] = useState(initial.state.leagueId || "1389331555339468800");
    const [previousSeasonFallback, setPreviousSeasonFallback] = useState(false);
    const [newRule, setNewRule] = useState("");
    const [newDuration, setNewDuration] = useState<"Weekly" | "Permanent">("Weekly");
    const [newBaseline, setNewBaseline] = useState("0");
    const [artImage, setArtImage] = useState<string | null>(null);
    const [artPreviewOpen, setArtPreviewOpen] = useState(false);
    const [draggingArt, setDraggingArt] = useState(false);
    const latestVersion = useRef(-1);
    const gameRef = useRef(game);
    const commandInFlight = useRef(false);
    const wheelPanelRef = useRef<HTMLElement>(null);
    const audioRef = useRef<AudioContext | null>(null);
    const artInputRef = useRef<HTMLInputElement | null>(null);
    const [importSeason, setImportSeason] = useState(2026);
    const [importWeek, setImportWeek] = useState(1);
    const canEdit = ready && !storageBlocked && (!roomId || Boolean(session && access?.canEdit));
    const handleArtFile = useCallback((fileList: FileList | null) => {
        const file = fileList?.[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setError("Please choose an image file for the art corner.");
            return;
        }
        const nextImage = URL.createObjectURL(file);
        setArtImage(current => {
            if (current?.startsWith("blob:"))
                URL.revokeObjectURL(current);
            return nextImage;
        });
        setNotice("Art saved to the chaos room.");
        setError("");
    }, []);
    useEffect(() => {
        try {
            const saved = localStorage.getItem("wanduball-art-v1");
            if (saved) setArtImage(saved);
        } catch {
            // Ignore storage errors in private browsing or restricted environments.
        }
    }, []);
    useEffect(() => {
        if (!artImage) {
            try {
                localStorage.removeItem("wanduball-art-v1");
            } catch {
                // Ignore storage errors in private browsing or restricted environments.
            }
            return;
        }
        try {
            localStorage.setItem("wanduball-art-v1", artImage);
        } catch {
            // Ignore storage errors in private browsing or restricted environments.
        }
    }, [artImage]);
    useEffect(() => () => {
        if (artImage?.startsWith("blob:"))
            URL.revokeObjectURL(artImage);
    }, [artImage]);
    const spinning = Boolean(game.lastSpin && now < game.lastSpin.startedAt + spinDurationMs);
    const spinAssignment = game.assignments.find(a => a.id === game.lastSpin?.id);
    const countdown = spinning && game.lastSpin ? Math.max(0, Math.ceil((game.lastSpin.startedAt - now) / 1000)) : 0;
    const revealedAssignments = game.assignments.filter(a => !spinning || (a.id !== game.lastSpin?.id && a.awardedWithSpinId !== game.lastSpin?.id));
    const activeAssignments = revealedAssignments.filter(a => isCurrent(game, a));
    const latestChange = [...game.changes].reverse().find(c => isCurrent(game, c));
    const selectedPool = pool(game, position);
    const [cleanupWorking, setCleanupWorking] = useState(false);
    const [cleanupLocked, setCleanupLocked] = useState(false);
    const [cleanupProgress, setCleanupProgress] = useState("");
    const cleanupStop = useRef(false);
    const cleanupOutgoing = useRef<{ roomId: string | null; season: number; week: number; version: number } | null>(null);
    useEffect(() => () => { cleanupStop.current = true; }, [roomId, canEdit]);
    const sleeper = useSleeperAssignments(roomId, tab === "assignments", canEdit && !cleanupLocked, version);
    const rosterBusy = cleanupWorking || cleanupLocked || sleeper.cleanupActive || sleeper.working || sleeper.autoPending || sleeper.autoPaused;
    const applied = activeAssignments.filter(a => sleeper.linked ? sleeper.result?.assignments[a.id]?.status === "applied" : a.applied).length;
    const acceptRoom = useCallback((data: Room) => {
        if (data.version >= latestVersion.current) {
            latestVersion.current = data.version;
            gameRef.current = stateSchema.parse(data.state);
            setNow(Date.now());
            setGame(gameRef.current);
            setVersion(data.version);
        }
    }, []);
    const openNextWeek = async () => {
        if (!sleeper.linked) {
            if (window.confirm(`Close week ${game.week} and open week ${game.week + 1}? This clears the current pools but preserves the ledger.`))
                void send({ type: "next-week" });
            return;
        }
        if (cleanupWorking || !canEdit || !supabase) return;
        setCleanupWorking(true);
        cleanupStop.current = false;
        setError("");
        const outgoing = cleanupOutgoing.current ?? { roomId, season: game.season, week: game.week, version };
        const invoke = async (action: "cleanup-preview" | "cleanup-step") => {
            const { data } = await supabase!.auth.getSession();
            if (!data.session) throw new Error("Sign in again to resume cleanup.");
            return requestJson<{ count?: number; done?: number; total?: number; completed?: boolean; room?: Room; operation?: unknown }>(
                "/api/room/sleeper", {
                    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
                    body: JSON.stringify({ ...outgoing, action }),
                });
        };
        try {
            setCleanupProgress("Checking outgoing week and Sleeper rosters…");
            const preview = await invoke("cleanup-preview");
            if (preview.completed && preview.room) {
                acceptRoom(preview.room);
                cleanupOutgoing.current = null;
                setCleanupLocked(false);
                setCleanupProgress("Outgoing roster cleanup verified. Next week is open.");
                return;
            }
            if (!window.confirm(`Drop week ${outgoing.week}'s ${preview.count ?? 0} assigned QB/RB/WR players from their original Sleeper rosters, then open week ${outgoing.week + 1}? TE and imported history stay. Already-absent players are skipped; moved players stop cleanup for commissioner review.`)) {
                setCleanupProgress("");
                return;
            }
            setCleanupLocked(true);
            cleanupOutgoing.current = outgoing;
            setCleanupProgress("Cleaning outgoing week. Leave this page open or stop and resume here.");
            while (!cleanupStop.current) {
                const result = await invoke("cleanup-step");
                if (result.completed && result.room) {
                    acceptRoom(result.room);
                    setCleanupLocked(false);
                    cleanupOutgoing.current = null;
                    setCleanupProgress("Outgoing roster cleanup verified. Next week is open.");
                    return;
                }
                setCleanupProgress(`${result.done ?? 0} of ${result.total ?? preview.count ?? 0} players verified. ${cleanupStop.current ? "Stopped; resume to finish." : "Cleaning outgoing week…"}`);
            }
        } catch (error) {
            setCleanupProgress("Stopped. Week will not advance until cleanup is verified. Resume to reconcile; completed drops are not repeated.");
            setError(error instanceof Error ? error.message : "Cleanup outcome unknown. Resume verification.");
        } finally {
            setCleanupWorking(false);
        }
    };
    useEffect(() => {
        if (!supabase)
            return;
        void supabase.auth.getSession().then(({ data, error }) => {
            if (error)
                setError(error.message);
            setSession(data.session);
        });
        const { data } = supabase.auth.onAuthStateChange((_event, session) => setSession(session));
        return () => data.subscription.unsubscribe();
    }, []);
    useEffect(() => {
        if (!settings && !help)
            return;
        const previousFocus = document.activeElement;
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setSettings(false);
                setHelp(false);
            }
            if (event.key !== "Tab" || !dialog)
                return;
            const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, [tabindex="0"]'));
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        };
        document.addEventListener("keydown", handleKey);
        const oldOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", handleKey);
            document.body.style.overflow = oldOverflow;
            if (previousFocus instanceof HTMLElement)
                previousFocus.focus();
        };
    }, [settings, help]);
    useEffect(() => {
        const spin = game.lastSpin;
        if (!spin)
            return;
        const timer = window.setInterval(() => {
            const currentTime = Date.now();
            setNow(currentTime);
            if (currentTime >= spin.startedAt + spinDurationMs)
                window.clearInterval(timer);
        }, 150);
        return () => window.clearInterval(timer);
    }, [game.lastSpin]);
    useEffect(() => {
        if (tab === "arena" && game.lastSpin && Date.now() < game.lastSpin.startedAt + spinDurationMs) {
            wheelPanelRef.current?.scrollIntoView({ behavior: "instant", block: "start" });
        }
    }, [tab, game.lastSpin]);
    useEffect(() => {
        if (!roomId || !supabase)
            return;
        let disposed = false;
        const refresh = async () => {
            try {
                const data = await requestJson<Room>(`/api/room?room=${encodeURIComponent(roomId)}`);
                if (disposed)
                    return;
                acceptRoom(data);
                setReady(true);
            }
            catch (error) {
                if (!disposed)
                    setError(error instanceof Error ? error.message : "Unable to load this room.");
            }
        };
        void refresh();
        const channel = supabase.channel(`wanduball-${roomId}`)
            .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, () => void refresh())
            .subscribe(status => {
            setConnected(status === "SUBSCRIBED");
            if (status === "SUBSCRIBED")
                void refresh();
        });
        // Polling catches missed events after sleep, reconnects, or a dropped websocket.
        const interval = window.setInterval(refresh, 15000);
        return () => { disposed = true; window.clearInterval(interval); void supabase!.removeChannel(channel); };
    }, [roomId, acceptRoom]);
    useEffect(() => {
        if (!ready || roomId)
            return;
        const handler = (event: StorageEvent) => {
            if (event.key !== storageKey || !event.newValue)
                return;
            try {
                const state = stateSchema.parse(JSON.parse(event.newValue));
                gameRef.current = state;
                setNow(Date.now());
                setGame(state);
            }
            catch {
                setError("Another tab saved incompatible practice data.");
            }
        };
        window.addEventListener("storage", handler);
        return () => window.removeEventListener("storage", handler);
    }, [ready, roomId]);
    async function send(command: Command) {
        if (!canEdit || busy || commandInFlight.current || rosterBusy)
            return;
        commandInFlight.current = true;
        setBusy(true);
        setError("");
        setNotice("");
        try {
            commandSchema.parse(command);
            if (roomId) {
                const before = gameRef.current;
                const token = (await supabase!.auth.getSession()).data.session?.access_token;
                if (!token)
                    throw new Error("Sign in again to operate the chaos room.");
                const data = await requestJson<Room>("/api/room", {
                    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ type: "command", roomId, version, command }),
                });
                acceptRoom(data);
                if (command.type === "assign") sleeper.committedSpin(before, data.state);
            }
            else {
                const next = transition(gameRef.current, command, randomIndex);
                localStorage.setItem(storageKey, JSON.stringify(next));
                gameRef.current = next;
                setNow(() => Date.now());
                setGame(next);
            }
            if (["assign", "coin", "rule", "points"].includes(command.type) && !muted)
                playSound();
            return true;
        }
        catch (error) {
            setError(error instanceof Error ? error.message : "Something went wrong. Your action was not confirmed.");
            if (roomId) {
                void refreshAccess();
                try {
                    acceptRoom(await requestJson<Room>(`/api/room?room=${encodeURIComponent(roomId)}`));
                }
                catch {
                    setError("Connection lost. Reconnect before trying again; the last action may have been saved.");
                }
            }
            return false;
        }
        finally {
            commandInFlight.current = false;
            setBusy(false);
        }
    }
    function playSound() {
        const context = audioRef.current ?? new AudioContext();
        audioRef.current = context;
        void context.resume();
        [220, 330, 440, 660].forEach((frequency, i) => {
            const oscillator = context.createOscillator(), gain = context.createGain();
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.type = "triangle";
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.06, context.currentTime + i * 0.12);
            gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + i * 0.12 + 0.2);
            oscillator.start(context.currentTime + i * 0.12);
            oscillator.stop(context.currentTime + i * 0.12 + 0.2);
        });
    }
    async function importPlayers() {
        setBusy(true);
        setError("");
        try {
            const data = await requestJson<Omit<Extract<Command, {
                type: "import";
            }>, "type">>(`/api/sleeper?leagueId=${encodeURIComponent(leagueId)}&season=${importSeason}&week=${importWeek}&statsSeason=${importWeek === 1 && previousSeasonFallback ? importSeason - 1 : importSeason}&ranking=league`);
            // Release the UI lock before sending the validated transition.
            setBusy(false);
            const command = commandSchema.parse({ ...data, type: "import" });
            await send(command);
        }
        catch (error) {
            setError(error instanceof Error ? error.message : "Sleeper import failed.");
            setBusy(false);
        }
    }
    async function createRoom() {
        if (!supabase || !session)
            return;
        setBusy(true);
        setError("");
        try {
            const token = (await supabase.auth.getSession()).data.session?.access_token;
            const data = await requestJson<Room & {
                roomId: string;
            }>("/api/room", {
                method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ type: "create" }),
            });
            router.push(`/?room=${encodeURIComponent(data.roomId)}`);
        }
        catch (error) {
            setError(error instanceof Error ? error.message : "Could not create the room.");
        }
        finally {
            setBusy(false);
        }
    }
    function exportLedger() {
        const url = URL.createObjectURL(new Blob([JSON.stringify(game, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `wanduball-${game.season}-week-${game.week}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setNotice("The evidence has been downloaded. Please do not eat it.");
    }
    async function share() {
        if (!roomId) {
            setSettings(true);
            return;
        }
        try {
            await navigator.clipboard.writeText(window.location.href);
            setNotice("Spectator link copied. Everyone with the link can watch.");
        }
        catch {
            setError("Could not copy the link. Copy this page's address from your browser.");
        }
    }
    const openArena = () => setTab("arena");
    return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setTab("clubhouse")} aria-label="Wanduball clubhouse"><span className="brand-icon"><Dices size={24}/></span><span>wanduball<span className="brand-dot">.</span><small>FANTASY. ALLEGEDLY.</small></span></button>
      <div className="league-card"><span className="league-emblem">W</span><div><strong>The Wanduball League</strong><small>Est. questionable decisions</small></div><ChevronDown size={15}/></div>
      <div className="nav-caption">OFFICIAL CHAOS HEADQUARTERS</div>
      <nav aria-label="Main navigation">{menu.map(({ tab: id, label, icon: Icon }) => <button key={id} aria-label={label} onClick={() => setTab(id)} className={tab === id ? "nav-item active" : "nav-item"} aria-current={tab === id ? "page" : undefined}>
          <Icon size={19}/><span>{label}</span>{id === "arena" && <span className="nav-live">LIVE</span>}
        </button>)}</nav>
      <div className="sidebar-bottom"><div className="commissioner-note"><span>✳</span><strong>The pocess is a wheel.</strong><p>Not responsible for your group chat.</p></div>
        <button className="nav-item" onClick={() => setHelp(true)}><CircleHelp size={18}/>What is happening?</button>
        <button className="profile" onClick={() => setSettings(true)}><span className="avatar purple">{session ? session.user.email?.slice(0, 1).toUpperCase() : "C"}</span><span><strong>{roomId ? canEdit ? "Commissioner" : "Distinguished spectator" : "Chaos coordinator"}<small>{roomId ? "Shared league room" : "Practice mode"}</small></strong></span><Settings2 size={17}/></button>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">THE LEAGUE <span>/</span> <strong>{menu.find(m => m.tab === tab)?.label}</strong></div><div className="topbar-right"><span className="season-tag">{game.season} SEASON</span><span className={`connection ${connected ? "online" : ""}`}><i />{roomId ? connected ? "Live connection" : "Connecting" : "Local practice"}</span><ThemePicker />
        <button className="icon-button" title="Room settings" aria-label="Room settings" onClick={() => setSettings(true)}><Settings2 size={18}/></button>
        <button className="icon-button" title={muted ? "Enable sound effects" : "Mute sound effects"} aria-label={muted ? "Enable sound effects" : "Mute sound effects"} onClick={() => { setMuted(!muted); if (muted)
        playSound(); }}>{muted ? <VolumeX size={18}/> : <Volume2 size={18}/>}</button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span className="tiny-star">✦</span> A VERY SERIOUS FANTASY FOOTBALL OPERATION</div><h1>{tab === "clubhouse" ? <>Welcome to the <span>nonsense.</span></> : tab === "setup" ? <>Prepare the <span>victims.</span></> : tab === "arena" ? <>Let the wheel <span>cook.</span></> : tab === "assignments" ? <>Department of <span>waiver crimes.</span></> : tab === "rules" ? <>The rules are <span>made up.</span></> : <>Keep the <span>receipts.</span></>}</h1><p>{tab === "clubhouse" ? "Ten managers. Zero ice cream. One KZ wheel." : tab === "setup" ? "Review the rankings. Remove the unavailable. Send ten brave souls into the wheel." : tab === "arena" ? "One result. Every screen. Absolutely no appeals." : tab === "assignments" ? "Make the moves in Sleeper. Keep the evidence here." : tab === "rules" ? "League-wide scoring changes, brought to you by profoundly bad ideas." : "A permanent record of temporary lapses in judgment."}</p></div><button className="button light" onClick={share}><Users size={16}/>Invite the degenerates<ArrowRight size={15}/></button></div>
        {!roomId && <div className="demo-banner"><span><Sparkles size={15}/><strong>Practice playground</strong> · Sample players & fictional points. Nothing here changes Sleeper.</span><button onClick={() => setSettings(true)}>Set up a live room <ArrowRight size={14}/></button></div>}
        {roomId && !canEdit && ready && <div className="demo-banner"><span><Radio size={15}/>Spectator mode. The commissioner controls the wheels; you supply the outrage.</span><button onClick={() => setSettings(true)}>Commissioner sign in</button></div>}
        {!settings && !help && (error || notice) && <div role={error ? "alert" : "status"} className={`notice ${error ? "error" : ""}`}><span>{error || notice}</span><button aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}><X size={17}/></button></div>}

        {tab === "clubhouse" && <>
          <section className="hero"><div className="hero-copy"><Pill tone="hero-pill"><span className="pulse-dot"/> WEEK {String(game.week).padStart(2, "0")} · CHAOS IS ON THE MENU</Pill><h2>Good teams win.<br /><span>Funny teams</span><br />get remembered.</h2><p>Your weekly dose of randomized rosters and<br className="desktop-break"/> deeply irresponsible scoring decisions.</p><button className="button dark" onClick={openArena}>Enter the chaos room <ArrowRight size={18}/></button><small><Radio size={13}/>{roomId ? "Watch together. Suffer together." : "Try a spin. No actual rosters will be harmed."}</small></div><div className="hero-art"><span className="sticker top">NO SKILL.<br />ALL VIBES.</span><Football /><span className="hero-ticket">WHEEL-APPROVED NONSENSE <Dices size={17}/></span></div><div className="hero-bottom">OFFICIALLY UNOFFICIAL <span>★</span> COMMISSIONER&apos;S WORST NIGHTMARE <span>★</span> LET THE WHEEL DECIDE <span>★</span></div></section>
          <div className="stats-grid">
            <Stat icon={Users} label="MANAGERS IN DANGER" value={String(game.managers.length).padStart(2, "0")} note="Nobody is safe." color="purple"/>
            <Stat icon={ClipboardList} label="PLAYERS REHOMED" value={String(activeAssignments.length).padStart(2, "0")} note={sleeper.linked && !sleeper.result ? "Live Sleeper status unavailable" : `${applied} confirmed in Sleeper`} color="green"/>
            <Stat icon={ShieldAlert} label="PERMANENT BAD IDEAS" value={String(game.changes.filter(c => c.rule.duration === "Permanent").length).padStart(2, "0")} note="These are here to stay." color="orange"/>
            <Stat icon={AudioLines} label="LEAGUE SANITY" value="0%" note="A remarkably consistent metric." color="pink"/>
          </div>
          <div className="section-heading"><div><h2>This week&apos;s questionable agenda <span>↴</span></h2><p>A foolproof plan. Heavy emphasis on fool.</p></div><Pill>WEEK {game.week}</Pill></div>
          <div className="agenda-grid">
            <Agenda number="01" icon={Users} title="The player shuffle" text="The top ten get new homes. Their managers get new problems." tag={game.locked.length ? `${game.locked.length} POOL${game.locked.length > 1 ? "S" : ""} LOCKED` : "NEEDS YOUR ATTENTION"} action="Review player pools" onClick={() => setTab("setup")} color="purple"/>
            <Agenda number="02" icon={Dices} title="Spin. Regret. Repeat." text="A coin, a rule, a point value. What could possibly go wrong?" tag={latestChange ? "CHAOS DELIVERED" : "AWAITING CHAOS"} action="To the chaos room" onClick={openArena} color="green"/>
            <Agenda number="03" icon={RotateCcw} title="Clean up the crime scene" text="Restore weekly scoring rules." tag="SCORING CLEANUP" action="Review scoring" onClick={() => setTab("rules")} color="orange"/>
          </div>
          <div className="bottom-grid"><section className="panel latest-chaos"><div className="panel-heading"><h3><Zap size={18}/> Latest act of chaos</h3><Pill tone="orange">LEAGUE-WIDE</Pill></div>{latestChange ? <><strong className="chaos-rule">{latestChange.rule.name}</strong><div className="point-change"><del>{signed(latestChange.previous)}</del><ArrowRight /><b>{signed(latestChange.value)}</b><span>points</span></div><p>{latestChange.rule.duration === "Permanent" ? "Permanent. Yes, really." : "This week only. Restore it before advancing."}</p></> : <div className="empty-inline"><span className="empty-dice"><Dices size={26}/></span><div><strong>Suspiciously normal. For now.</strong><p>The next scoring disaster will appear here.</p></div></div>}<button className="text-button" onClick={() => setTab("rules")}>View the rulebook <ArrowRight size={15}/></button></section>
            <section className="manifesto"><span>WORDS TO LOSE BY</span><blockquote>“Fantasy football is<br />mostly luck. We just<br /><em>made it official.</em>”</blockquote><small>— THE WANDUBALL CONSTITUTION, PROBABLY</small><span className="manifesto-star">✳</span></section></div>
        </>}

        {tab === "setup" && <>
          <section className="panel import-panel"><div><h3><ExternalLink size={18}/> Straight from the Sleeper swamp</h3><p>Selected week&apos;s actual points using this league&apos;s Sleeper scoring. All roster statuses, ranked by position. Exclude injuries and byes manually.</p></div><form className="import-form" onSubmit={e => { e.preventDefault(); void importPlayers(); }}><label className="wide">Sleeper league ID<input required pattern="[0-9]+" placeholder="e.g. 1234567890123456789" value={leagueId} onChange={e => setLeagueId(e.target.value)}/></label><label>League season<input type="number" min="2020" max="2100" value={importSeason} onChange={e => setImportSeason(Number(e.target.value))} required/></label><label>Week<input type="number" min="1" max="18" value={importWeek} onChange={e => setImportWeek(Number(e.target.value))} required/></label>{importWeek === 1 && <label>Week 1 statistics<select value={previousSeasonFallback ? "previous" : "current"} onChange={e => setPreviousSeasonFallback(e.target.value === "previous")}><option value="current">{importSeason} Week 1 actuals</option><option value="previous">{importSeason - 1} full-season fallback</option></select></label>}<button className="button dark" disabled={!canEdit || busy || Boolean(game.locked.length)}>{busy ? <LoaderCircle className="loading" size={16}/> : <ArrowDownToLine size={16}/>}Pull the players</button></form><small>Week N uses Week N, not previous weeks or season totals. Current-week results may be partial. Import is read-only; nothing gets changed in Sleeper.</small></section>
          <div className="section-heading"><div><h2>The unwilling participants</h2><p>{game.source}</p></div><button className="button purple" disabled={!canEdit || busy || game.locked.includes(position) || selectedPool.length !== 10} onClick={() => void send({ type: "lock", position })}><LockKeyhole size={16}/>{game.locked.includes(position) ? `${position} pool locked` : `Lock ${position} top 10`}</button></div>
          <PositionTabs position={position} setPosition={setPosition} game={game}/>
          <p className="nickname-help">Nicknames are optional (up to {nicknameMaxLength} characters). Save an empty nickname or use Clear to remove it. Names carry into future imports; past assignments keep their original nickname. You can edit locked pools, but not during a countdown or spin.</p>
          <div className="panel table-panel"><div className="table-info"><span><strong>{selectedPool.length}/10</strong> eligible players on the wheel</span><span>Exclude a player and the next-ranked candidate moves up.</span></div><div className="table-scroll"><table><thead><tr><th>RANK</th><th>THE PLAYER</th><th>TEAM</th><th>FANTASY POINTS</th><th>HEALTH REPORT</th><th>ON THE WHEEL?</th></tr></thead><tbody>{game.players.filter(p => p.position === position).sort((a, b) => b.points - a.points).map((player, i) => <tr key={player.id} className={game.excluded.includes(player.id) ? "excluded-row" : ""}><td><span className={`rank ${i < 3 ? "top" : ""}`}>{String(i + 1).padStart(2, "0")}</span></td><td><PlayerName player={player} nickname={game.nicknames?.[player.id]}/><PlayerNicknameEditor key={`${player.id}-${game.nicknames?.[player.id] ?? ""}`} playerName={player.name} nickname={game.nicknames?.[player.id] ?? ""} disabled={!canEdit || busy || spinning} onSave={nickname => send({ type: "nickname", playerId: player.id, nickname })}/></td><td><Pill>{player.team || "FA"}</Pill></td><td className="score">{player.points.toFixed(1)}</td><td>{player.injury ? <Pill tone="orange">{player.injury}</Pill> : <span className="muted">No injury flag</span>}</td><td><button className={`eligibility ${game.excluded.includes(player.id) ? "" : selectedPool.some(p => p.id === player.id) ? "included" : ""}`} disabled={!canEdit || busy || game.locked.includes(position)} onClick={() => void send({ type: "exclude", playerId: player.id })}>{game.excluded.includes(player.id) ? <X size={14}/> : <Check size={14}/>}{game.excluded.includes(player.id) ? "Excluded" : selectedPool.some(p => p.id === player.id) ? "In the pool" : "Reserve"}</button></td></tr>)}</tbody></table></div>{!game.players.length && <Empty title="The pool is currently a puddle." text="Import Sleeper rankings above to start this week."/>}<div className="table-footer"><ShieldAlert size={15}/>Byes are not automatically detected. Check availability in Sleeper before locking.<button className="text-button" onClick={openArena}>Ready? To the wheels <ArrowRight size={15}/></button></div></div>
        </>}

        {tab === "arena" && <div className="arena-grid">
          <section className="panel wheel-panel" ref={wheelPanelRef}>
            <div className="panel-heading"><h3><Radio size={18}/> The wheel of questionable destiny</h3><Pill tone="green">{roomId ? connected ? "LIVE ROOM" : "RECONNECTING" : "PRACTICE"}</Pill></div>
            <div className={`spin-heads-up ${spinning && spinAssignment ? "has-victim" : ""}`} role="status" aria-atomic="true">
              <div>
                <span>{spinAssignment ? countdown ? "YOU'RE UP. BRACE YOURSELF." : spinning ? "CURRENTLY SPINNING FOR" : "THE LATEST VICTIM" : game.lastSpin ? "LEAGUE-WIDE CHAOS" : "A COURTESY WARNING. NOT A CHOICE."}</span>
                <h2>{spinAssignment?.manager.name ?? (game.lastSpin ? "Everybody's on the hook." : "Your manager gets called first.")}</h2>
                <p>{spinAssignment ? countdown ? `Your ${spinAssignment.player.position} wheel starts in ${countdown}...` : spinning ? `Finding your new ${spinAssignment.player.position}. Please remain alarmed.` : `${spinAssignment.player.position} delivered. Emotional support not included.` : game.lastSpin ? "This one affects every manager. Equal-opportunity nonsense." : "A 3-second heads-up. Then the player wheel decides."}</p>
              </div>
              {spinAssignment && countdown > 0 && <strong className="spin-countdown" aria-hidden="true">{countdown}</strong>}
            </div>
            <Wheel spin={game.lastSpin} now={now} fallback={selectedPool.map(p => playerLabel(p, game.nicknames?.[p.id]))} fallbackLabels={selectedPool.map(p => game.nicknames?.[p.id] ?? p.name)} playerSpin={Boolean(spinAssignment)}/>
            <div className="wheel-result" aria-live="polite">
              <span>{countdown && spinAssignment ? "GET READY. THE WHEEL IS NEXT." : spinning ? "CONSULTING THE FOOTBALL GODS..." : game.lastSpin ? "THE WHEEL HAS SPOKEN" : "YOUR FATE IS BUFFERING"}</span>
              <h2>{spinning ? "Please hold your outrage." : game.lastSpin?.label ?? "It’s probably fine."}</h2>
              <p>{spinning ? "A legally non-binding moment of suspense." : game.lastSpin?.detail ?? "Choose a position, then let chaos do its thing."}</p>
            </div>
          </section>
          <div className="arena-controls">
            {canEdit && sleeper.linked && <section className="panel">
              <h3>Live Sleeper adds</h3>
              {liveAutoEnabled(roomId, game) ? <>
                <label><input type="checkbox" role="switch" aria-label="Automatic Sleeper adds" checked={sleeper.autoEnabled} disabled={rosterBusy} onChange={e => sleeper.setAutoEnabled(e.target.checked)}/> Add after each player wheel reveal</label>
                <p role="status">{sleeper.autoPaused ? "Auto-add paused. Resolve the roster issue, then resume verification." : sleeper.progress || (sleeper.autoEnabled ? "On · new spins in this tab only. No backlog or scoring edits." : "Off · apply assignments manually.")}</p>
                {sleeper.error && <p role="alert">{sleeper.error}</p>}
                {sleeper.autoPaused && <button className="button dark" onClick={sleeper.resumeAuto}>Resume roster verification</button>}
              </> : <p>Automatic adds start in 2026 Week 3. This week stays manual.</p>}
            </section>}
            <AutoWheel game={game} canEdit={canEdit} busy={busy || rosterBusy} spinning={spinning} suspended={settings || help || sleeper.autoPaused} error={error} onSpin={async command => {
                if (command.type === "assign")
                    setPosition(command.position);
                return send(command);
            }} />
            <section className="panel">
              <Pill tone="purple">ROUND 01 · PLAYER ASSIGNMENTS</Pill><h3>Find them a new home.</h3>
              <p>Manager first. Player next. No repeats.</p>
              <PositionTabs position={position} setPosition={setPosition} game={game}/>
              <div className="progress-label"><span>{position} assignment progress</span><strong>{currentAssignments(game, position).length}/10</strong></div>
              <div className="progress-track"><i style={{ width: `${currentAssignments(game, position).length * 10}%` }}/></div>
              <button className="button dark full" disabled={!canEdit || busy || rosterBusy || spinning || !game.locked.includes(position) || currentAssignments(game, position).length === 10} onClick={() => void send({ type: "assign", position })}><Dices size={18}/>{spinning ? "Chaos in progress..." : `Assign a ${position}`}<ArrowRight size={17}/></button>
              {!game.locked.includes(position) && <button className="text-button" onClick={() => setTab("setup")}>Review and lock this pool first <ArrowRight size={14}/></button>}
            </section>
            <section className="panel chaos-controls">
              <Pill tone="orange">ROUND 02 · EVERYONE&apos;S PROBLEM</Pill><h3>Break the scoring system.</h3><p>This round is hands-on. Make it count.</p>
              <button className="step-button" disabled={!canEdit || busy || rosterBusy || spinning || Boolean(game.pending.duration || latestChange)} onClick={() => void send({ type: "coin" })}><span>1</span><div><strong>Flip the duration coin</strong><small>{game.pending.duration ?? latestChange?.rule.duration ?? "Weekly or permanent?"}</small></div><Dices size={17}/></button>
              <button className="step-button" disabled={!canEdit || busy || rosterBusy || spinning || !game.pending.duration || Boolean(game.pending.ruleId)} onClick={() => void send({ type: "rule" })}><span>2</span><div><strong>Pick the terrible rule</strong><small>{game.rules.find(r => r.id === game.pending.ruleId)?.name ?? latestChange?.rule.name ?? "The matching rule wheel"}</small></div><ShieldAlert size={17}/></button>
              <button className="step-button" disabled={!canEdit || busy || rosterBusy || spinning || !game.pending.ruleId} onClick={() => void send({ type: "points" })}><span>3</span><div><strong>Make the points worse</strong><small>{latestChange ? `${signed(latestChange.value)} points. Incredible.` : "A replacement value, not a bonus"}</small></div><Zap size={17}/></button>
            </section>
            <section className={`panel art-corner ${draggingArt ? "dragging" : ""}`}>
              <div className="art-corner-header">
                <Pill tone="purple">ART CORNER</Pill>
                {artImage && <button type="button" className="text-button" onClick={() => setArtPreviewOpen(true)}>Preview</button>}
              </div>
              <div className="art-upload-zone" onDragOver={event => { event.preventDefault(); setDraggingArt(true); }} onDragLeave={() => setDraggingArt(false)} onDrop={event => { event.preventDefault(); setDraggingArt(false); handleArtFile(event.dataTransfer.files); }} onClick={() => artInputRef.current?.click()}>
                <input ref={artInputRef} type="file" accept="image/*" hidden onChange={event => handleArtFile(event.target.files)} />
                {artImage ? <button type="button" className="art-image-button" onClick={event => { event.stopPropagation(); setArtPreviewOpen(true); }} aria-label="Preview uploaded art"><img src={artImage} alt="Uploaded art from the chaos room" /></button> : <>
                  <Sparkles size={28} />
                  <strong>Drop your masterpiece here</strong>
                  <span>or upload an image</span>
                </>}
              </div>
              <div className="art-actions">
                <button type="button" className="button dark" onClick={() => artInputRef.current?.click()}><Plus size={16}/>Upload image</button>
                {artImage && <button type="button" className="button light" onClick={() => setArtImage(null)}>Remove</button>}
              </div>
            </section>
          </div>
          {artPreviewOpen && artImage && <div className="modal-overlay art-preview-overlay" onClick={() => setArtPreviewOpen(false)}><section role="dialog" aria-modal="true" aria-label="Large art preview" className="art-preview-modal" onClick={event => event.stopPropagation()}><button type="button" className="modal-close icon-button" aria-label="Close art preview" onClick={() => setArtPreviewOpen(false)}><X size={20}/></button><img src={artImage} alt="Full-size preview of the uploaded art" /></section></div>}
          <section className="panel arena-recent">
            <div className="panel-heading"><h3>The newly inconvenienced</h3><button className="text-button" onClick={() => setTab("assignments")}>All assignments <ArrowRight size={14}/></button></div>
            {activeAssignments.length ? <div className="recent-grid">{[...activeAssignments].reverse().slice(0, 6).map(a => <div className="recent-assignment" key={a.id}><PlayerName player={a.player} nickname={a.nickname}/><ArrowRight size={16}/><strong>{a.manager.name}</strong></div>)}</div> : <Empty title={spinning && spinAssignment ? "Assignment incoming. No spoilers." : "No victims. Yet."} text="Your assignment results land here and in the weekly ledger after the wheel stops."/>}
          </section>
        </div>}

        {tab === "assignments" && <>
          <div className="checklist-banner"><div><Pill tone="orange">{sleeper.linked ? "LIVE SLEEPER ROSTERS" : "MANUAL IN SLEEPER"}</Pill><h2>The wheel makes decisions.<br />You do the paperwork.</h2><p>{sleeper.linked ? "Verify membership below. Commissioners may apply one eligible absent player after confirmation. Drops remain manual in Sleeper." : "Assign the players in Sleeper, then confirm below. At week's end, drop them before waivers and mark each drop."}</p></div><ClipboardList size={76} strokeWidth={1}/></div>
          {sleeper.linked && <section className="panel"><p>Live Sleeper membership, not a manual checklist. Imported roster history is read-only and can never be applied. Adds outside the integration&apos;s approved round are blocked.</p><p>{!canEdit ? "Sign in as a commissioner to verify status." : sleeper.error || (sleeper.result ? `Verified at ${new Date(sleeper.result.checkedAt).toLocaleTimeString()}` : "Status unavailable until verification completes.")}</p><button className="button" disabled={!canEdit || sleeper.working} onClick={() => void sleeper.refresh()}>Refresh Sleeper status</button></section>}
          <section className="panel table-panel"><div className="panel-heading"><h3>Week {game.week} · roster relocation program</h3><Pill>{sleeper.linked && !sleeper.result ? "STATUS UNAVAILABLE" : `${applied}/${activeAssignments.length} APPLIED`}</Pill></div><div className="table-scroll"><table><thead><tr><th>LUCKY MANAGER</th><th>NEW RESPONSIBILITY</th><th>POSITION</th><th>APPLIED IN SLEEPER</th></tr></thead><tbody>{activeAssignments.map(a => <tr key={a.id}><td><strong>{a.manager.name}</strong></td><td><PlayerName player={a.player} nickname={a.nickname}/></td><td><Pill tone="purple">{a.player.position}</Pill></td><td>{sleeper.linked ? <SleeperAssignmentCell status={sleeper.result?.assignments[a.id]} disabled={!canEdit || busy || spinning || sleeper.working} apply={() => void sleeper.apply(a)}/> : <button className={`check-button ${a.applied ? "checked" : ""}`} disabled={!canEdit || busy || spinning} onClick={() => void send({ type: "assignment-status", id: a.id, field: "applied" })}><Check size={15}/>{a.applied ? "Applied" : "Confirm applied"}</button>}</td></tr>)}</tbody></table></div>{!activeAssignments.length && <Empty title="Nobody has been relocated." text="Run the assignment wheels to populate your checklist."/>}</section>
          {sleeper.linked && canEdit && <div className="panel sleeper-apply-footer">
            <span role="status">{sleeper.progress || "Adds eligible players to their assigned teams. No drops."}</span>
            {sleeper.working
              ? <button className="button light" onClick={sleeper.stop}>Stop after this player</button>
              : <button className="button dark" disabled={busy || spinning || (sleeper.autoPending && !sleeper.autoPaused) || !activeAssignments.some(a => sleeper.result?.assignments[a.id]?.canApply)} onClick={() => void sleeper.applyAll(activeAssignments)}>Apply to all</button>}
            {sleeper.autoPaused && <button className="button dark" disabled={sleeper.working} onClick={sleeper.resumeAuto}>Resume roster verification</button>}
          </div>}
          <section className="panel week-close"><div><h3><RotateCcw size={18}/> Wrap it up. Do it again.</h3><p>Confirm weekly scoring restores and permanent rule applications. {sleeper.linked ? "Opening next week drops outgoing QB/RB/WR assignments from Sleeper. TE and imported history stay." : "History stays; next week starts with a fresh import."}</p>
            {cleanupProgress && <p role="status" aria-live="polite">{cleanupProgress}</p>}</div>
            {cleanupWorking && <button className="button" onClick={() => { cleanupStop.current = true; setCleanupProgress("Stopping after the current verification. Resume here when ready."); }}>Stop after current player</button>}
            <button className="button dark" disabled={!canEdit || busy || spinning || cleanupWorking || (!(cleanupLocked || sleeper.cleanupActive) && rosterBusy)} onClick={() => void openNextWeek()}>{cleanupLocked || sleeper.cleanupActive ? "Resume cleanup" : `Open week ${game.week + 1}`}<ArrowRight size={17}/></button></section>
        </>}

        {tab === "rules" && <>
          <section className="panel"><div className="panel-heading"><h3>Actual consequences</h3><Pill tone="orange">CHANGES APPLY TO EVERY TEAM</Pill></div>{!game.changes.length ? <Empty title="The rulebook is still technically legal." text="Spin the duration, rule, and points wheels to create a league-wide scoring change."/> : <div className="rule-changes">{[...game.changes].reverse().map(c => <div className="rule-change" key={c.id}><div><Pill tone={c.rule.duration === "Permanent" ? "purple" : "orange"}>{c.rule.duration}</Pill><small>{c.season} · Week {c.week}</small><h3>{c.rule.name}</h3><p>{signed(c.previous)} <ArrowRight size={13}/> <strong>{signed(c.value)} points</strong>{c.reverted && " · Restored"}</p></div><div className="rule-actions"><button className={`check-button ${c.applied ? "checked" : ""}`} disabled={!canEdit || busy || spinning} onClick={() => void send({ type: "change-status", id: c.id, field: "applied" })}><Check size={14}/>{c.applied ? "Applied in Sleeper" : "Confirm applied"}</button>{c.rule.duration === "Weekly" && <button className={`check-button ${c.reverted ? "checked" : ""}`} disabled={!canEdit || busy || spinning || !c.applied} onClick={() => void send({ type: "change-status", id: c.id, field: "reverted" })}><RotateCcw size={14}/>{c.reverted ? "Restored" : `Restore ${signed(c.previous)}`}</button>}</div></div>)}</div>}</section>
          <section className="panel points-menu">
            <div className="panel-heading"><h3><Zap size={18}/>The points wheel</h3><Pill tone="orange">15 EQUALLY BAD POSSIBILITIES</Pill></div>
            <p>The selected value replaces the rule&apos;s current points. It does not get added on top.</p>
            <div className="points-options">{[...pointsWheel].sort((a, b) => a - b).map(value => <span key={value} className={value < 0 ? "negative" : ""}>{signed(value)}</span>)}</div>
          </section>
          <div className="section-heading"><div><h2>The menu of bad ideas</h2><p>Seeded from your Season 2 chaos document. Baselines are defaults until you import your league.</p></div><Pill>{game.rules.length} RULES</Pill></div>
          <div className="rules-grid">{(["Weekly", "Permanent"] as const).map(duration => <section className="panel" key={duration}><div className="panel-heading"><h3>{duration === "Weekly" ? <RotateCcw size={19}/> : <LockKeyhole size={19}/>}{duration} wheel</h3><Pill tone={duration === "Weekly" ? "orange" : "purple"}>{duration === "Weekly" ? "THIS TOO SHALL PASS" : "FOREVER PROBLEM"}</Pill></div><div className="rule-list">{game.rules.filter(r => r.duration === duration).map(r => <div key={r.id}><span>{r.name}</span><small>BASE {signed(r.baseline)}</small></div>)}</div></section>)}</div>
          <section className="panel add-rule"><h3><Plus size={18}/> Submit a terrible idea</h3><form className="import-form" onSubmit={async (e) => { e.preventDefault(); if (await send({ type: "add-rule", rule: { id: `custom-${crypto.randomUUID()}`, name: newRule.trim(), duration: newDuration, baseline: Number(newBaseline) } }))
            setNewRule(""); }}><label className="wide">Scoring rule name<input required maxLength={80} value={newRule} onChange={e => setNewRule(e.target.value)} placeholder="Something your commissioner can set in Sleeper"/></label><label>Duration<select value={newDuration} onChange={e => setNewDuration(e.target.value as "Weekly" | "Permanent")}><option>Weekly</option><option>Permanent</option></select></label><label>Current points<input type="number" step="any" required value={newBaseline} onChange={e => setNewBaseline(e.target.value)}/></label><button className="button dark" disabled={!canEdit || busy || spinning || !newRule.trim()}><Plus size={16}/>Add to wheel</button></form><small>Custom rules must correspond to a scoring setting you can apply manually. Playoff 10× ideas are not automated in this version.</small></section>
        </>}

        {tab === "history" && <>
          <section className="panel ledger-heading"><div><h3><History size={19}/> The permanent paper trail</h3><p>Every assignment and scoring change. Even the ones you&apos;d rather forget.</p></div><button className="button dark" onClick={exportLedger}><ArrowDownToLine size={16}/>Export the evidence</button></section>
          {!!game.rosterHistory?.length && <section className="panel">
            <div className="panel-heading"><h3>Imported Sleeper roster history</h3><Pill>{game.rosterHistory.length} COMMISSIONER ADDS</Pill></div>
            <p>Reconstructed from completed roster transactions, not original wheel results. No historical fantasy points, player statistics, nicknames, or scoring outcomes are inferred. Later removals retain their actual transaction dates.</p>
            {game.rosterHistory.map(a => <div className="history-row" key={a.id}>
              <Pill>{a.player.position}</Pill><strong>{a.player.name}</strong><ArrowRight size={15}/><span>{a.manager.name}</span>
              <small>{a.season} · Week {a.week} · Imported commissioner add<br/>
                Transaction {a.transactionId} · {new Date(a.occurredAt).toISOString().slice(0, 10)}
                {a.removalTransactionId && <><br/>Later removed · {new Date(a.removedAt!).toISOString().slice(0, 10)} · Transaction {a.removalTransactionId}</>}
              </small>
            </div>)}
          </section>}
          {!revealedAssignments.length && !game.changes.length ? <section className="panel"><Empty title="A clean record. How embarrassing." text="Finish a wheel spin and your first entry will appear here."/></section> : <div className="history-list">{Array.from(new Set([...revealedAssignments, ...game.changes].map(a => `${a.season}-${a.week}`))).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(key => { const [season, week] = key.split("-").map(Number); const assignments = revealedAssignments.filter(a => a.week === week && a.season === season), changes = game.changes.filter(c => c.week === week && c.season === season); return <section className="panel" key={key}><div className="panel-heading"><h3>{season} · Week {String(week).padStart(2, "0")}</h3><Pill>{assignments.length} RELOCATIONS</Pill></div>{changes.map(c => <div className="history-rule" key={c.id}><Zap size={17}/><strong>{c.rule.name}: {signed(c.previous)} → {signed(c.value)}</strong><Pill tone="purple">{c.rule.duration}</Pill></div>)}{assignments.map(a => <div className="history-row" key={a.id}><Pill>{a.player.position}</Pill><strong>{playerLabel(a.player, a.nickname)}</strong><ArrowRight size={15}/><span>{a.manager.name}</span><small>{a.dropped ? "Dropped" : a.applied ? "Applied" : "Needs applying"}</small></div>)}</section>; })}</div>}
        </>}
        <footer><span><Dices size={15}/>WANDUBALL. WHERE LOGIC GOES ON IR.</span><span>Made with poor judgment & excellent intentions. <span className="footer-star">✳</span></span></footer>
      </main>
    </div>
    {(settings || help) && <div className="modal-overlay" onClick={() => { setSettings(false); setHelp(false); }}><section role="dialog" aria-modal="true" aria-labelledby="modal-title" className="modal" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" autoFocus aria-label="Close dialog" onClick={() => { setSettings(false); setHelp(false); }}><X size={20}/></button>{help ? <><Pill tone="purple">THE ORIENTATION NOBODY ASKED FOR</Pill><h2 id="modal-title">Welcome to organized nonsense.</h2><ol className="help-list"><li><strong>Review the top ten.</strong> Import Sleeper stats, manually exclude injuries/byes, and lock each position you want to assign.</li><li><strong>Relocate some football players.</strong> Every spin pairs a remaining player with a remaining manager, without repeats.</li><li><strong>Ruin everybody&apos;s scoring.</strong> Weekly or permanent? Which rule? How many points? Let three wheels decide.</li><li><strong>Make it real in Sleeper.</strong> This app never changes your league directly. Confirm roster and scoring edits after making them yourself.</li><li><strong>Clean up before waivers.</strong> Drop assigned players, restore weekly scoring, then advance the week.</li></ol></> : <><Pill tone="green">THE BORING PART THAT MAKES THE FUN PART WORK</Pill><h2 id="modal-title">Chaos control center.</h2>{!supabase ? <><p>You&apos;re in local practice mode. Your results are saved in this browser, not shared across devices.</p><div className="setup-note"><strong>To bring the whole league:</strong><p>Connect a Supabase project using the included <code>.env.example</code>, run the SQL migration, and create your commissioner account. Full instructions are in <code>README.md</code>.</p></div></> : session ? <><p>Signed in as <strong>{session.user.email}</strong>.</p>{!roomId && <><p>Create a fresh shared room. Practice results will stay here; the live room begins with an empty player pool.</p><button className="button dark full" disabled={busy} onClick={createRoom}><Radio size={17}/>Create a live room</button></>}{roomId && <button className="button light full" onClick={share}><Copy size={16}/>Copy spectator link</button>}<button className="text-button" onClick={async () => { const { error } = await supabase!.auth.signOut(); if (error)
        setError(error.message); }}><LogOut size={16}/>Sign out</button></> : <><p>Sign in with the commissioner account created in Supabase. Spectators don&apos;t need an account.</p><form className="login-form" onSubmit={async (e) => { e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); const { error } = await supabase!.auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) }); setBusy(false); if (error)
        setError(error.message); }}><label>Email<input name="email" type="email" required autoComplete="email"/></label><label>Password<input name="password" type="password" required autoComplete="current-password"/></label><button className="button dark" disabled={busy}><LogIn size={17}/>Commissioner sign in</button></form></>}
        {roomId && session && <RoomCommissioners key={`${roomId}-${session.user.id}`} access={access} onChange={changeCommissioner} />}
        <div className="modal-divider"/><p className="small-print">Live room game data is publicly readable. Do not put private information in manager names or rules. The room creator and added commissioners can change results. Only the creator manages commissioner access.</p><button className="button light full" onClick={exportLedger}><ArrowDownToLine size={16}/>Download league backup</button>{!roomId && <button className="text-button danger" onClick={() => { if (window.confirm("Reset this browser's practice game? Export a backup first if you want to keep it.")) {
        try {
            const fresh = initialState();
            localStorage.setItem(storageKey, JSON.stringify(fresh));
            gameRef.current = fresh;
            setGame(fresh);
            setStorageBlocked(false);
            setSettings(false);
            setError("");
        }
        catch {
            setError("Browser storage is unavailable. Practice was not reset.");
        }
    } }}><RotateCcw size={15}/>Reset local practice</button>}</>}{(error || notice) && <div role={error ? "alert" : "status"} className={`notice ${error ? "error" : ""}`}>{error || notice}</div>}</section></div>}
  </div>;
}
function Stat({ icon: Icon, label, value, note, color }: {
    icon: typeof Trophy;
    label: string;
    value: string;
    note: string;
    color: string;
}) {
    return <section className="stat-card"><div className="stat-top"><span>{label}</span><i className={`stat-icon ${color}`}><Icon size={19}/></i></div><strong className="stat-value">{value}</strong><p>{note}</p></section>;
}
function Agenda({ number, icon: Icon, title, text, tag, action, onClick, color }: {
    number: string;
    icon: typeof Trophy;
    title: string;
    text: string;
    tag: string;
    action: string;
    onClick: () => void;
    color: string;
}) {
    return <section className="agenda-card"><div className="agenda-top"><span className={`agenda-icon ${color}`}><Icon size={23}/></span><span className="agenda-number">{number}</span></div><Pill tone={color}>{tag}</Pill><h3>{title}</h3><p>{text}</p><button onClick={onClick}>{action}<ArrowRight size={17}/></button></section>;
}
function PositionTabs({ position, setPosition, game }: {
    position: Position;
    setPosition: (p: Position) => void;
    game: GameState;
}) {
    return <div className="position-tabs" aria-label="Choose player position">{positions.map(p => <button key={p} disabled={!enabledPositions.includes(p)} title={!enabledPositions.includes(p) ? "Disabled for now" : undefined} aria-pressed={p === position} className={p === position ? "selected" : ""} onClick={() => setPosition(p)}>{p}{game.locked.includes(p) && <LockKeyhole size={12}/>}</button>)}</div>;
}
function PlayerName({ player, nickname }: {
    player: Player;
    nickname?: string;
}) {
    return <div className={`player-name${nickname ? " has-nickname" : ""}`}><span className={`player-avatar pos-${player.position.toLowerCase()}`}>{player.name.split(" ").map(s => s[0]).slice(0, 2).join("")}</span><span><strong>{nickname ?? player.name}</strong>{nickname && <small className="player-real-name">{player.name}</small>}<small>{player.position} · {player.team}</small></span></div>;
}
function Empty({ title, text }: {
    title: string;
    text: string;
}) {
    return <div className="empty"><Dices size={32} strokeWidth={1.5}/><h3>{title}</h3><p>{text}</p></div>;
}
function Wheel({ spin, now, fallback, fallbackLabels, playerSpin }: {
    spin: GameState["lastSpin"];
    now: number;
    fallback: string[];
    fallbackLabels: string[];
    playerSpin: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const options = spin?.options ?? (fallback.length ? fallback : ["CHAOS", "REGRET", "GLORY", "PAIN", "VIBES", "LUCK"]);
    // Older saved spins retain full labels; strip only their appended real-name suffix for display.
    const labels = spin ? spin.sliceLabels ?? (playerSpin ? options.map(name => name.replace(/ \([^()]+\)$/, "")) : options) : fallback.length ? fallbackLabels : options;
    const landed = Boolean(spin && now >= spin.startedAt + spinDurationMs);
    const segment = 360 / options.length;
    const colors = wheelColors(options.length);
    const gradient = options.map((_, i) => `${colors[i]} ${i * segment}deg ${(i + 1) * segment}deg`).join(", ");
    const finalRotation = spin ? 1800 + (360 - (spin.index + 0.5) * segment) : 0;
    useEffect(() => {
        const el = ref.current;
        if (!el || !spin)
            return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const remaining = spin.startedAt + spinDurationMs - Date.now();
            el.style.transform = remaining > 0 ? "rotate(0deg)" : `rotate(${finalRotation}deg)`;
            const timer = window.setTimeout(() => { el.style.transform = `rotate(${finalRotation}deg)`; }, Math.max(0, remaining));
            return () => window.clearTimeout(timer);
        }
        const elapsed = Date.now() - spin.startedAt;
        const animation = el.animate([{ transform: "rotate(0deg)" }, { transform: `rotate(${finalRotation}deg)` }], {
            duration: spinDurationMs, delay: Math.max(0, -elapsed), easing: "cubic-bezier(0.16, 0.8, 0.18, 1)", fill: "both",
        });
        if (elapsed > 0)
            animation.currentTime = Math.min(elapsed, spinDurationMs);
        return () => animation.cancel();
    }, [spin, finalRotation]);
    if (spin?.options[0] === "Weekly" && spin.options[1] === "Permanent") {
        return <DurationCoin spin={spin} />;
    }
    return <div className={`wheel-wrap kz-wheel ${!spin || playerSpin ? "player-wheel" : ""} ${spin && now >= spin.startedAt && now < spin.startedAt + spinDurationMs ? "is-spinning" : ""}`}>
        <div className="wheel-pointer"/>
        <div className="wheel-frame">
            <div className="wheel-disc" ref={ref} style={{ background: `conic-gradient(${gradient})` }}>
                {options.map((name, i) => <div className={`wheel-label ${landed && spin?.index === i ? "winning-label" : ""}`} key={`${i}-${name}`} style={{ transform: `rotate(${(i + 0.5) * segment}deg)` }}>
                    <span title={name} aria-label={name}>{(labels[i] ?? name).length > 21 ? `${(labels[i] ?? name).slice(0, 20).trimEnd()}…` : labels[i] ?? name}</span>
                </div>)}
            </div>
            <div className="wheel-hub"><Image src="/wanduball-mascot.jpg" alt="Wanduball mascot" width={750} height={1000} sizes="110px" /><small>KZ APPROVED</small></div>
        </div>
        <span className="wheel-scribble">zero ice cream. all destiny. ↗</span>
    </div>;
}

function DurationCoin({ spin }: { spin: NonNullable<GameState["lastSpin"]> }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const coin = ref.current;
        if (!coin) return;
        const rotation = 2160 + spin.index * 180;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            coin.style.transform = `rotateY(${rotation}deg)`;
            return;
        }
        const elapsed = Date.now() - spin.startedAt;
        const animation = coin.animate([
            { transform: "rotateY(0deg) translateY(0)" },
            { transform: `rotateY(${rotation / 2}deg) translateY(-35px)`, offset: 0.45 },
            { transform: `rotateY(${rotation}deg) translateY(0)` },
        ], { duration: spinDurationMs, delay: Math.max(0, -elapsed), easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" });
        if (elapsed > 0) animation.currentTime = Math.min(elapsed, spinDurationMs);
        return () => animation.cancel();
    }, [spin]);
    return <div className="wheel-wrap coin-stage" aria-label="Duration coin">
        <div className="duration-coin" ref={ref}>
            <div className="coin-face"><RotateCcw size={54} /><strong>WEEKLY</strong><span>TEMPORARY SUFFERING</span><small>ONE WEEK. STILL YOUR PROBLEM.</small></div>
            <div className="coin-face coin-back"><LockKeyhole size={54} /><strong>PERMANENT</strong><span>FOREVER PROBLEM</span><small>NO TAKEBACKS, BESTIE.</small></div>
        </div>
        <span className="wheel-scribble">financially worthless ↗</span>
    </div>;
}
