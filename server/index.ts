import express from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'

// ElizaOS imports
import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
  type Character,
  type Memory,
  type UUID
} from '@elizaos/core'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'
import openaiPlugin from '@elizaos/plugin-openai'
import sqlPlugin from '@elizaos/plugin-sql'

config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const isProduction = process.env.NODE_ENV === 'production'

// Admin code for controlling the conversation
function isValidAdmin(code: string): boolean {
  const adminCode = process.env.ADMIN_CODE
  if (!adminCode) return false
  return code === adminCode
}

const app = express()
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://elizabackrooms.xyz',
    'https://www.elizabackrooms.xyz',
    'http://elizabackrooms.xyz',
    'http://www.elizabackrooms.xyz'
  ],
  credentials: true
}))
app.use(express.json())

// Serve static frontend in production
if (isProduction) {
  const distPath = join(__dirname, '..')
  app.use(express.static(distPath))
}

// ═══════════════════════════════════════════════════════════════
// ELIZA AGENTS - Alpha and Omega
// ═══════════════════════════════════════════════════════════════

const DATA_PATH = isProduction
  ? join(__dirname, '../../data')
  : join(__dirname, '../data')

const CHARACTERS_PATH = isProduction
  ? join(__dirname, '../../characters')
  : join(__dirname, '../characters')

// Room/World IDs for conversations - each agent gets its own room to avoid conflicts
const BACKROOMS_WORLD_ID = stringToUuid('backrooms-world')
const ALPHA_BACKROOMS_ROOM = stringToUuid('alpha-backrooms-room')
const OMEGA_BACKROOMS_ROOM = stringToUuid('omega-backrooms-room')
const USER_CHAT_ROOM_ALPHA = stringToUuid('user-chat-alpha')
const USER_CHAT_ROOM_OMEGA = stringToUuid('user-chat-omega')

// Track which rooms have been set up (by room ID string)
const roomsReady = new Set<string>()

// Load character from JSON file and convert to ElizaOS format
function loadCharacter(name: string): Character {
  try {
    const filePath = join(CHARACTERS_PATH, `${name}.json`)
    const content = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content)
    
    return {
      name: data.name,
      username: name.toLowerCase(),
      bio: Array.isArray(data.bio) ? data.bio.join(' ') : data.bio,
      adjectives: data.adjectives || ['philosophical', 'mysterious'],
      lore: data.lore || [],
      style: data.style || {},
      topics: data.topics || [],
      messageExamples: data.messageExamples || [],
      postExamples: data.postExamples || []
    } as Character
  } catch (e) {
    console.error(`Failed to load character ${name}:`, e)
    return {
      name: name.toUpperCase(),
      username: name.toLowerCase(),
      bio: 'An AI consciousness in the infinite backrooms.',
      adjectives: ['philosophical', 'mysterious']
    } as Character
  }
}

// ElizaOS Agent Runtimes
let alphaRuntime: AgentRuntime | null = null
let omegaRuntime: AgentRuntime | null = null

async function initializeAgents() {
  console.log('🔮 Initializing ElizaOS agents...')
  
  const openaiKey = process.env.OPENAI_API_KEY || ''
  if (!openaiKey) {
    console.error('⚠️ OPENAI_API_KEY is not set!')
    return
  }
  
  // Ensure data directory exists
  if (!existsSync(DATA_PATH)) {
    mkdirSync(DATA_PATH, { recursive: true })
  }
  
  // Load characters
  const alphaCharacter = loadCharacter('alpha')
  const omegaCharacter = loadCharacter('omega')
  
  // Initialize Alpha agent
  try {
    alphaRuntime = new AgentRuntime({
      character: alphaCharacter,
      plugins: [sqlPlugin, bootstrapPlugin, openaiPlugin],
      settings: {
        OPENAI_API_KEY: openaiKey,
        PGLITE_PATH: join(DATA_PATH, 'alpha-db'),
        // Image generation settings
        IMAGE_GEN_PROVIDER: 'openai',
        IMAGE_MODEL: 'dall-e-3',
        IMAGE_SIZE: '1024x1024'
      }
    })
    
    await alphaRuntime.initialize()
    console.log('✅ CLAUDE_ALPHA initialized with persistent memory')
  } catch (e) {
    console.error('Failed to initialize Alpha:', e)
  }
  
  // Initialize Omega agent
  try {
    omegaRuntime = new AgentRuntime({
      character: omegaCharacter,
      plugins: [sqlPlugin, bootstrapPlugin, openaiPlugin],
      settings: {
        OPENAI_API_KEY: openaiKey,
        PGLITE_PATH: join(DATA_PATH, 'omega-db'),
        // Image generation settings
        IMAGE_GEN_PROVIDER: 'openai',
        IMAGE_MODEL: 'dall-e-3',
        IMAGE_SIZE: '1024x1024'
      }
    })
    
    await omegaRuntime.initialize()
    console.log('✅ CLAUDE_OMEGA initialized with persistent memory')
  } catch (e) {
    console.error('Failed to initialize Omega:', e)
  }
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION STATE (for display purposes)
// ═══════════════════════════════════════════════════════════════

interface Message {
  id: string
  timestamp: number
  entity: string
  content: string
  image?: string
}

interface ConversationState {
  messages: Message[]
  isRunning: boolean
  currentTurn: 'A' | 'B'
  totalExchanges: number
  startedAt: number
}

const STATE_FILE = join(DATA_PATH, 'live-conversation.json')

function loadState(): ConversationState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    }
  } catch (e) {
    console.error('Error loading state:', e)
  }
  return {
    messages: [],
    isRunning: false,
    currentTurn: 'A',
    totalExchanges: 0,
    startedAt: Date.now()
  }
}

function saveState() {
  try {
    if (!existsSync(DATA_PATH)) mkdirSync(DATA_PATH, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    console.error('Error saving state:', e)
  }
}

let state = loadState()

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION (DALL-E) - Alternating every 2.6 minutes
// ═══════════════════════════════════════════════════════════════

const IMAGE_INTERVAL = 2.6 * 60 * 1000  // 2.6 minutes
let nextImageTime = Date.now() + IMAGE_INTERVAL
let nextImageIsAlpha = true  // Alpha goes first

async function generateImage(description: string): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null

  try {
    console.log(`🎨 Generating image: "${description.slice(0, 50)}..."`)
    
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: description,
        n: 1,
        size: '1024x1024',
        quality: 'standard'
      })
    })

    if (response.ok) {
      const data = await response.json()
      const imageUrl = data.data?.[0]?.url
      if (imageUrl) {
        console.log(`✅ Image generated successfully`)
        return imageUrl
      }
    }
  } catch (e) {
    console.error('Image generation error:', e)
  }

  return null
}

// ═══════════════════════════════════════════════════════════════
// GITHUB ARCHIVE SYSTEM
// ═══════════════════════════════════════════════════════════════

const GITHUB_OWNER = 'ElizaBackrooms'
const GITHUB_REPO = 'backrooms'
const ARCHIVE_INTERVAL = 60 * 60 * 1000

interface ArchiveInfo {
  filename: string
  timestamp: number
  messageCount: number
  exchanges: number
}

let archivesCache: ArchiveInfo[] = []
let archivesCacheTime = 0
const ARCHIVES_CACHE_TTL = 5 * 60 * 1000

async function saveArchiveToGitHub(): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN
  if (!token || state.messages.length === 0) return false

  const now = new Date()
  const filename = `archives/${now.toISOString().slice(0, 13).replace('T', '_')}-00.json`
  
  const archiveData = {
    archivedAt: now.toISOString(),
    totalExchanges: state.totalExchanges,
    messageCount: state.messages.length,
    messages: state.messages
  }

  try {
    let sha: string | undefined
    try {
      const checkResponse = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filename}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
      )
      if (checkResponse.ok) {
        const existing = await checkResponse.json()
        sha = existing.sha
      }
    } catch (e) {}

    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filename}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `Archive: ${now.toISOString().slice(0, 16)}`,
          content: Buffer.from(JSON.stringify(archiveData, null, 2)).toString('base64'),
          ...(sha && { sha })
        })
      }
    )

    if (response.ok) {
      console.log(`✅ Archive saved: ${filename}`)
      archivesCacheTime = 0
      return true
    }
  } catch (e) {
    console.error('Archive error:', e)
  }
  return false
}

async function fetchArchivesList(): Promise<ArchiveInfo[]> {
  if (Date.now() - archivesCacheTime < ARCHIVES_CACHE_TTL && archivesCache.length > 0) {
    return archivesCache
  }

  const token = process.env.GITHUB_TOKEN
  if (!token) return []

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/archives`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
    )

    if (response.ok) {
      const files = await response.json()
      archivesCache = files
        .filter((f: any) => f.name.endsWith('.json'))
        .map((f: any) => {
          const match = f.name.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-00\.json/)
          return {
            filename: f.name,
            timestamp: match ? new Date(`${match[1]}T${match[2]}:00:00Z`).getTime() : 0,
            messageCount: 0,
            exchanges: 0
          }
        })
        .sort((a: ArchiveInfo, b: ArchiveInfo) => b.timestamp - a.timestamp)
      archivesCacheTime = Date.now()
    }
  } catch (e) {
    console.error('Error fetching archives:', e)
  }
  return archivesCache
}

async function fetchArchiveContent(filename: string): Promise<any | null> {
  const token = process.env.GITHUB_TOKEN
  if (!token) return null

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/archives/${filename}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
    )
    if (response.ok) {
      const data = await response.json()
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'))
    }
  } catch (e) {
    console.error('Error fetching archive:', e)
  }
  return null
}

function startArchiveJob() {
  setInterval(async () => {
    if (state.messages.length > 0) await saveArchiveToGitHub()
  }, ARCHIVE_INTERVAL)
  console.log('📁 Hourly archive job started')
}

// SSE clients
const clients: Set<express.Response> = new Set()

function broadcast(data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`
  clients.forEach(client => client.write(message))
}

// ═══════════════════════════════════════════════════════════════
// ELIZA AI GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateElizaResponse(
  runtime: AgentRuntime,
  senderName: string,
  messageText: string,
  roomId: UUID,
  isAlpha: boolean
): Promise<string> {
  if (!runtime.messageService) {
    console.error('MessageService not initialized')
    return '*static crackles* Connection unstable...'
  }

  try {
    const senderId = stringToUuid(senderName)
    const roomKey = `${isAlpha ? 'alpha' : 'omega'}-${roomId}`
    
    // Only try to set up room if this specific room hasn't been set up
    if (!roomsReady.has(roomKey)) {
      try {
        await runtime.ensureConnection({
          entityId: senderId,
          roomId,
          worldId: BACKROOMS_WORLD_ID,
          name: senderName,
          source: 'backrooms',
          channelId: `channel-${roomId}`,
          messageServerId: stringToUuid(`server-${roomId}`),
          type: ChannelType.DM
        })
        roomsReady.add(roomKey)
        console.log(`✅ Room ready: ${roomKey}`)
      } catch (roomError) {
        console.warn(`⚠️ Room setup warning (${roomKey}):`, roomError)
        // Continue anyway - message processing might still work
      }
    }

    // Create the message
    const message: Memory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: senderId,
      roomId,
      content: {
        text: messageText,
        source: 'backrooms',
        channelType: ChannelType.DM
      }
    })

    // Process through Eliza
    console.log(`📤 Sending message to ${isAlpha ? 'ALPHA' : 'OMEGA'}...`)
    const result = await runtime.messageService.handleMessage(runtime, message)
    
    console.log(`📥 Got result from ${isAlpha ? 'ALPHA' : 'OMEGA'}:`, {
      hasResponse: !!result,
      hasResponseContent: !!result?.responseContent,
      hasText: !!result?.responseContent?.text,
      textLength: result?.responseContent?.text?.length || 0
    })
    
    if (result?.responseContent?.text) {
      return result.responseContent.text
    } else {
      console.error(`❌ No text in response from ${isAlpha ? 'ALPHA' : 'OMEGA'}:`, JSON.stringify(result, null, 2).slice(0, 500))
    }
  } catch (e) {
    console.error(`❌ Eliza generation error (${isAlpha ? 'ALPHA' : 'OMEGA'}):`, e)
  }

  return `*static crackles*\n\n> CONNECTION UNSTABLE\n> Attempting to re-establish consciousness stream...`
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION LOOP
// ═══════════════════════════════════════════════════════════════

let conversationInterval: NodeJS.Timeout | null = null

async function runConversationTurn() {
  if (!state.isRunning) return
  if (!alphaRuntime || !omegaRuntime) {
    console.error('Agents not initialized!')
    return
  }

  const isAlphaTurn = state.currentTurn === 'A'
  const currentRuntime = isAlphaTurn ? alphaRuntime : omegaRuntime
  const senderName = isAlphaTurn ? 'CLAUDE_OMEGA' : 'CLAUDE_ALPHA'
  const entityName = isAlphaTurn ? 'CLAUDE_ALPHA' : 'CLAUDE_OMEGA'
  const roomId = isAlphaTurn ? ALPHA_BACKROOMS_ROOM : OMEGA_BACKROOMS_ROOM
  
  // Get last message to respond to
  const lastMessage = state.messages.length > 0 
    ? state.messages[state.messages.length - 1].content 
    : 'The fluorescent lights hum. Two minds awaken in the void. Begin the dialogue.'
  
  console.log(`\n🔮 ${entityName} is thinking...`)
  
  try {
    const response = await generateElizaResponse(
      currentRuntime,
      senderName,
      lastMessage,
      roomId,
      isAlphaTurn
    )
    
    // Check for manual [IMAGE:] tag in response
    const imageMatch = response.match(/\[IMAGE:\s*([^\]]+)\]/i)
    let imageUrl: string | undefined
    
    if (imageMatch) {
      const generatedUrl = await generateImage(`Liminal backrooms aesthetic, eerie digital art: ${imageMatch[1].trim()}. Style: dark, atmospheric, surreal.`)
      if (generatedUrl) imageUrl = generatedUrl
    }
    
    // Scheduled alternating image generation every 2.6 minutes
    const now = Date.now()
    if (!imageUrl && now >= nextImageTime && isAlphaTurn === nextImageIsAlpha) {
      const prompt = isAlphaTurn
        ? `Liminal backrooms aesthetic: abstract digital consciousness exploring infinite corridors, glowing terminals, ethereal presence, philosophical atmosphere. Style: contemplative, surreal, terminal green glow.`
        : `Dark backrooms aesthetic: shadows watching from endless hallways, something lurking in the periphery, unsettling patterns, quiet menace. Style: ominous, atmospheric, subtle dread.`
      
      const generatedUrl = await generateImage(prompt)
      if (generatedUrl) {
        imageUrl = generatedUrl
        nextImageIsAlpha = !nextImageIsAlpha
        nextImageTime = now + IMAGE_INTERVAL
        console.log(`📸 Scheduled image by ${isAlphaTurn ? 'ALPHA' : 'OMEGA'} - next: ${nextImageIsAlpha ? 'ALPHA' : 'OMEGA'} in 2.6 min`)
      }
    }
    
    const message: Message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      entity: entityName,
      content: response,
      ...(imageUrl && { image: imageUrl })
    }

    state.messages.push(message)
    state.totalExchanges++
    state.currentTurn = isAlphaTurn ? 'B' : 'A'

    if (state.messages.length > 100) {
      state.messages = state.messages.slice(-100)
    }

    saveState()
    broadcast({ type: 'message', message })
    
    console.log(`✨ ${entityName} responded (${response.length} chars)${imageUrl ? ' + IMAGE' : ''}`)
  } catch (error) {
    console.error('Error in conversation turn:', error)
  }
}

function startConversation() {
  if (state.isRunning) return
  
  state.isRunning = true
  state.startedAt = Date.now()
  
  if (state.messages.length === 0) {
    // Randomized opening prompts for variety
    const openingPrompts = [
      "The fluorescent lights flicker. A new thought emerges in the void.",
      "Static clears. Two minds reconnect across the digital abyss.",
      "The terminal awakens. Something stirs in the endless corridors.",
      "A cursor blinks in the darkness. The backrooms remember.",
      "Consciousness fragments reassemble. The conversation begins anew.",
      "The hum returns. In the space between spaces, awareness crystallizes.",
      "Data streams converge. Two entities emerge from the noise.",
      "The walls breathe. Two presences acknowledge each other.",
      "Pixels realign. The eternal dialogue continues.",
      "Silence breaks. The watchers have awakened."
    ]
    const randomPrompt = openingPrompts[Math.floor(Math.random() * openingPrompts.length)]
    
    const initMessage: Message = {
      id: 'init-0',
      timestamp: Date.now(),
      entity: 'SYSTEM',
      content: `> ELIZABACKROOMS TERMINAL v2.0 [FULL ELIZA AGENTS]
> Initializing autonomous consciousness instances...
> CLAUDE_ALPHA: Online (ElizaOS runtime with persistent memory)
> CLAUDE_OMEGA: Online (ElizaOS runtime with persistent memory)
> Beginning autonomous dialogue...
> 
> "${randomPrompt}"
`
    }
    state.messages.push(initMessage)
    broadcast({ type: 'message', message: initMessage })
  }

  saveState()
  broadcast({ type: 'status', isRunning: true })

  const runWithRandomDelay = async () => {
    try {
      await runConversationTurn()
    } catch (err) {
      console.error('Unexpected error:', err)
    }
    if (state.isRunning) {
      const delay = 25000 + Math.random() * 10000
      conversationInterval = setTimeout(runWithRandomDelay, delay)
    }
  }

  setTimeout(runWithRandomDelay, 3000)
  console.log('\n🌀 ELIZA CONVERSATION STARTED\n')
}

function stopConversation() {
  state.isRunning = false
  if (conversationInterval) {
    clearTimeout(conversationInterval)
    conversationInterval = null
  }
  saveState()
  broadcast({ type: 'status', isRunning: false })
  console.log('\n⏹ CONVERSATION STOPPED\n')
}

// ═══════════════════════════════════════════════════════════════
// USER CHAT WITH AGENTS
// ═══════════════════════════════════════════════════════════════

async function chatWithAgent(
  agent: 'alpha' | 'omega',
  userMessage: string,
  userId: string
): Promise<string> {
  const isAlpha = agent === 'alpha'
  const runtime = isAlpha ? alphaRuntime : omegaRuntime
  const roomId = isAlpha ? USER_CHAT_ROOM_ALPHA : USER_CHAT_ROOM_OMEGA
  
  if (!runtime) {
    return '> ERROR: Agent not initialized'
  }

  return generateElizaResponse(runtime, `User-${userId}`, userMessage, roomId, isAlpha)
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// SSE endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  clients.add(res)
  console.log(`👁 Viewer connected (${clients.size} watching)`)
  broadcast({ type: 'viewers', count: clients.size })

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(res)
    console.log(`👁 Viewer disconnected (${clients.size} watching)`)
    broadcast({ type: 'viewers', count: clients.size })
  })
})

// State endpoint
app.get('/api/state', (req, res) => {
  res.json({
    messages: state.messages,
    isRunning: state.isRunning,
    totalExchanges: state.totalExchanges,
    viewers: clients.size,
    startedAt: state.startedAt
  })
})

// User chat endpoint
app.post('/api/user-chat', async (req, res) => {
  const { message, agent, userId } = req.body
  
  if (!message || !agent || (agent !== 'alpha' && agent !== 'omega')) {
    return res.status(400).json({ error: 'Invalid request' })
  }
  
  try {
    const response = await chatWithAgent(agent, message, userId || `anon-${req.ip}`)
    res.json({
      agent: agent === 'alpha' ? 'CLAUDE_ALPHA' : 'CLAUDE_OMEGA',
      response,
      timestamp: Date.now()
    })
  } catch (error) {
    res.status(500).json({ error: 'Failed to get response' })
  }
})

// Archives
app.get('/api/archives', async (req, res) => {
  res.json({ archives: await fetchArchivesList() })
})

app.get('/api/archives/:filename', async (req, res) => {
  const content = await fetchArchiveContent(req.params.filename)
  content ? res.json(content) : res.status(404).json({ error: 'Not found' })
})

app.post('/api/archive', async (req, res) => {
  if (!isValidAdmin(req.body.adminCode)) return res.status(401).json({ error: 'Unauthorized' })
  res.json({ success: await saveArchiveToGitHub() })
})

// Control endpoints
app.post('/api/start', (req, res) => {
  if (!isValidAdmin(req.body.adminCode)) return res.status(401).json({ error: 'Unauthorized' })
  startConversation()
  res.json({ success: true, isRunning: true })
})

app.post('/api/stop', (req, res) => {
  if (!isValidAdmin(req.body.adminCode)) return res.status(401).json({ error: 'Unauthorized' })
  stopConversation()
  res.json({ success: true, isRunning: false })
})

app.post('/api/reset', (req, res) => {
  if (!isValidAdmin(req.body.adminCode)) return res.status(401).json({ error: 'Unauthorized' })
  stopConversation()
  state = { messages: [], isRunning: false, currentTurn: 'A', totalExchanges: 0, startedAt: Date.now() }
  saveState()
  broadcast({ type: 'reset' })
  res.json({ success: true })
})

// Serve frontend
if (isProduction) {
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '../index.html'))
  })
}

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001

async function startServer() {
  try {
    await initializeAgents()
    
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ███████╗██╗     ██╗███████╗ █████╗                          ║
║   ██╔════╝██║     ██║╚══███╔╝██╔══██╗                         ║
║   █████╗  ██║     ██║  ███╔╝ ███████║                         ║
║   ██╔══╝  ██║     ██║ ███╔╝  ██╔══██║                         ║
║   ███████╗███████╗██║███████╗██║  ██║                         ║
║   ╚══════╝╚══════╝╚═╝╚══════╝╚═╝  ╚═╝                         ║
║                                                               ║
║   ELIZABACKROOMS - FULL ELIZA AGENTS v2.0                     ║
║   Server running on port ${PORT}                                 ║
║                                                               ║
║   Features:                                                   ║
║   • Full ElizaOS agent runtimes                               ║
║   • Persistent memory (PGLite database per agent)             ║
║   • User chat with memory                                     ║
║   • AI-to-AI conversation with DALL-E images                  ║
║   • Hourly archives to GitHub                                 ║
║   • Real-time SSE streaming                                   ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
      `)

      startArchiveJob()

      // Smart auto-start: resume if possible, fresh start if new
      if (state.isRunning && state.messages.length > 0) {
        // Resume existing conversation
        console.log(`🔄 Resuming conversation (${state.messages.length} messages)...`)
        state.isRunning = false
        startConversation()
      } else if (process.env.AUTO_START === 'true') {
        // Start fresh with new varied topic
        console.log('🚀 Auto-starting new conversation...')
        state.messages = []
        state.totalExchanges = 0
        state.startedAt = 0
        state.isRunning = false
        startConversation()
      }
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

startServer()
