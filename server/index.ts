import express from 'express'
import cors from 'cors'
import { config } from 'dotenv'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
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
import { ScheduledImageGenerator } from './scheduled-image-generator.js'

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

const ARCHIVES_PATH = isProduction
  ? join(__dirname, '../../archives')
  : join(__dirname, '../archives')

const CHARACTERS_PATH = isProduction
  ? join(__dirname, '../../characters')
  : join(__dirname, '../characters')

// Ensure directories exist
if (!existsSync(DATA_PATH)) mkdirSync(DATA_PATH, { recursive: true })
if (!existsSync(ARCHIVES_PATH)) mkdirSync(ARCHIVES_PATH, { recursive: true })

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
let imageGenerator: ScheduledImageGenerator | null = null

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
    console.log('✅ CLAUDE_ALPHA initialized with ElizaOS persistent memory')
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
    console.log('✅ CLAUDE_OMEGA initialized with ElizaOS persistent memory')
  } catch (e) {
    console.error('Failed to initialize Omega:', e)
  }
  
  // Load conversation history from ElizaOS database
  await loadConversationFromDatabase()
  
  // Initialize image generator AFTER agents are ready
  if (alphaRuntime && omegaRuntime) {
    // Use a shared room ID for the gallery system
    const SHARED_BACKROOMS_ROOM = stringToUuid('shared-backrooms-gallery')
    
    imageGenerator = new ScheduledImageGenerator(
      alphaRuntime,
      omegaRuntime,
      SHARED_BACKROOMS_ROOM
    )
    
    // Start the scheduled image generation
    imageGenerator.start()
    console.log('🎨 Scheduled image generator started')
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

// ═══════════════════════════════════════════════════════════════
// ELIZAOS NATIVE MEMORY SYSTEM
// ═══════════════════════════════════════════════════════════════

// Helper to access database adapter (TypeScript workaround)
function getDatabaseAdapter(runtime: AgentRuntime | null): any {
  if (!runtime) return null
  // databaseAdapter is available but not in TypeScript types
  return (runtime as any).databaseAdapter || (runtime as any).database
}

// Load conversation history from ElizaOS database
async function loadConversationFromDatabase(): Promise<void> {
  const alphaDb = getDatabaseAdapter(alphaRuntime)
  const omegaDb = getDatabaseAdapter(omegaRuntime)
  
  if (!alphaDb || !omegaDb) {
    console.log('⚠️ Runtimes not initialized yet, skipping database load')
    return
  }

  try {
    // Load messages from Alpha's room (shared conversation)
    const alphaMemories = await alphaDb.getMemories({
      roomId: ALPHA_BACKROOMS_ROOM,
      count: 1000,
      unique: false
    })

    // Load messages from Omega's room
    const omegaMemories = await omegaDb.getMemories({
      roomId: OMEGA_BACKROOMS_ROOM,
      count: 1000,
      unique: false
    })

    // Combine and sort by timestamp
    const allMemories = [...alphaMemories, ...omegaMemories]
      .filter(m => m.content?.text)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

    if (allMemories.length > 0) {
      // Convert ElizaOS memories to display format
      state.messages = allMemories.map((mem, idx) => ({
        id: mem.id || `db-${idx}`,
        timestamp: mem.createdAt || Date.now(),
        entity: mem.content?.source === 'CLAUDE_ALPHA' ? 'CLAUDE_ALPHA' : 
                mem.content?.source === 'CLAUDE_OMEGA' ? 'CLAUDE_OMEGA' : 
                'UNKNOWN',
        content: mem.content?.text || ''
      }))

      // Determine whose turn it is based on last message
      const lastMessage = state.messages[state.messages.length - 1]
      state.currentTurn = lastMessage.entity === 'CLAUDE_ALPHA' ? 'B' : 'A'
      state.totalExchanges = Math.floor(state.messages.length / 2)

      console.log(`✅ Loaded ${state.messages.length} messages from ElizaOS database`)
      console.log(`📍 Last speaker: ${lastMessage.entity}`)
    }
  } catch (e) {
    console.error('Error loading conversation from database:', e)
  }
}

// Get recent memories using ElizaOS's native system
async function getRecentMemoriesFromDatabase(
  runtime: AgentRuntime,
  roomId: UUID,
  count: number = 20
): Promise<Memory[]> {
  const db = getDatabaseAdapter(runtime)
  if (!db) return []
  
  try {
    return await db.getMemories({
      roomId,
      count,
      unique: false
    })
  } catch (e) {
    console.error('Error getting recent memories:', e)
    return []
  }
}

function loadState(): ConversationState {
  try {
    if (existsSync(STATE_FILE)) {
      const loadedState = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
      console.log(`✅ Loaded ${loadedState.messages?.length || 0} messages from state file`)
      return loadedState
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

function saveState(): void {
  try {
    if (!existsSync(DATA_PATH)) mkdirSync(DATA_PATH, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    console.error('Error saving state:', e)
  }
}

let state = loadState()

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION (DALL-E) - Manual/On-demand only
// Scheduled images are handled by ScheduledImageGenerator
// ═══════════════════════════════════════════════════════════════

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
// LOCAL + GITHUB ARCHIVE SYSTEM (Non-resetting)
// ═══════════════════════════════════════════════════════════════

const GITHUB_OWNER = 'ElizaBackrooms'
const GITHUB_REPO = 'backrooms'
const ARCHIVE_INTERVAL = 60 * 60 * 1000 // Hourly

interface ArchiveInfo {
  filename: string
  timestamp: number
  messageCount: number
  exchanges: number
  size?: number
  created?: Date
}

let archivesCache: ArchiveInfo[] = []
let archivesCacheTime = 0
const ARCHIVES_CACHE_TTL = 5 * 60 * 1000

// Track last archive date for daily rollover
let lastArchiveDate: string = new Date().toDateString()

// Generate archive filename based on date
function getArchiveFilename(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  return `${year}-${month}-${day}_${hour}00.json`
}

// Save archive locally WITHOUT clearing the live conversation
async function saveLocalArchive(reason: string = 'scheduled'): Promise<string | null> {
  const alphaDb = getDatabaseAdapter(alphaRuntime)
  const omegaDb = getDatabaseAdapter(omegaRuntime)
  
  if (!alphaDb || !omegaDb) {
    console.warn('⚠️ Runtimes not initialized, skipping archive')
    return null
  }
  
  try {
    // Get all memories from ElizaOS database
    const alphaMemories = await alphaDb.getMemories({
      roomId: ALPHA_BACKROOMS_ROOM,
      count: 100000,
      unique: false
    })
    
    const omegaMemories = await omegaDb.getMemories({
      roomId: OMEGA_BACKROOMS_ROOM,
      count: 100000,
      unique: false
    })
    
    // Combine and sort
    const allMemories = [...alphaMemories, ...omegaMemories]
      .filter(m => m.content?.text)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    
    if (allMemories.length === 0) return null
    
    const archiveFilename = getArchiveFilename()
    const archivePath = join(ARCHIVES_PATH, archiveFilename)
    
    // Create archive with ElizaOS memories
    const archiveData = {
      archivedAt: new Date().toISOString(),
      reason: reason,
      messageCount: allMemories.length,
      totalExchanges: state.totalExchanges,
      alphaAgentId: alphaRuntime?.agentId,
      omegaAgentId: omegaRuntime?.agentId,
      memories: allMemories.map(m => ({
        id: m.id,
        userId: (m as any).userId,
        agentId: (m as any).agentId,
        roomId: m.roomId,
        content: m.content,
        createdAt: m.createdAt
      })),
      // Also include display format for compatibility
      conversation: state.messages
    }
    
    writeFileSync(archivePath, JSON.stringify(archiveData, null, 2), 'utf-8')
    console.log(`📦 Local archive saved: ${archiveFilename} (${allMemories.length} ElizaOS memories, reason: ${reason})`)
    return archiveFilename
  } catch (e) {
    console.error('Error creating local archive:', e)
    return null
  }
}

// Check if we need daily rollover archive
async function checkDailyArchive(): Promise<void> {
  const today = new Date().toDateString()
  
  const alphaDb = getDatabaseAdapter(alphaRuntime)
  if (today !== lastArchiveDate && (state.messages.length > 0 || alphaDb)) {
    console.log('🕐 New day detected, creating daily rollover archive...')
    await saveLocalArchive('daily_rollover')
    lastArchiveDate = today
  }
}

// Save to GitHub (async, non-blocking)
async function saveArchiveToGitHub(reason: string = 'hourly_snapshot'): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN
  const alphaDb = getDatabaseAdapter(alphaRuntime)
  if (!token || (!alphaDb && state.messages.length === 0)) return false

  const now = new Date()
  const filename = `archives/${now.toISOString().slice(0, 13).replace('T', '_')}-00.json`
  
  try {
    // Get memories from ElizaOS database if available
    let memories: Memory[] = []
    const alphaDb = getDatabaseAdapter(alphaRuntime)
    const omegaDb = getDatabaseAdapter(omegaRuntime)
    
    if (alphaDb && omegaDb) {
      const alphaMemories = await alphaDb.getMemories({
        roomId: ALPHA_BACKROOMS_ROOM,
        count: 100000,
        unique: false
      })
      const omegaMemories = await omegaDb.getMemories({
        roomId: OMEGA_BACKROOMS_ROOM,
        count: 100000,
        unique: false
      })
      memories = [...alphaMemories, ...omegaMemories]
        .filter(m => m.content?.text)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    }
    
    const archiveData = {
      archivedAt: now.toISOString(),
      reason: reason,
      totalExchanges: state.totalExchanges,
      messageCount: memories.length || state.messages.length,
      memories: memories.length > 0 ? memories.map(m => ({
        id: m.id,
        userId: (m as any).userId,
        agentId: (m as any).agentId,
        roomId: m.roomId,
        content: m.content,
        createdAt: m.createdAt
      })) : undefined,
      conversation: state.messages, // Display format for compatibility
      alphaAgentId: alphaRuntime?.agentId,
      omegaAgentId: omegaRuntime?.agentId
    }

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
          message: `Archive: ${now.toISOString().slice(0, 16)} (${reason})`,
          content: Buffer.from(JSON.stringify(archiveData, null, 2)).toString('base64'),
          ...(sha && { sha })
        })
      }
    )

    if (response.ok) {
      console.log(`✅ GitHub archive saved: ${filename}`)
      archivesCacheTime = 0
      return true
    }
  } catch (e) {
    console.error('GitHub archive error:', e)
  }
  return false
}

// List local archives
function listLocalArchives(): ArchiveInfo[] {
  try {
    if (!existsSync(ARCHIVES_PATH)) return []
    
    const files = readdirSync(ARCHIVES_PATH)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
    
    return files.map(filename => {
      const filepath = join(ARCHIVES_PATH, filename)
      const stats = statSync(filepath)
      const match = filename.match(/(\d{4}-\d{2}-\d{2})_(\d{2})00\.json/)
      
      // Try to read archive metadata for accurate counts
      let messageCount = 0
      let exchanges = 0
      try {
        const archiveContent = JSON.parse(readFileSync(filepath, 'utf-8'))
        messageCount = archiveContent.messageCount || 
                      archiveContent.messages?.length || 
                      archiveContent.conversation?.length || 
                      archiveContent.memories?.length || 0
        exchanges = archiveContent.totalExchanges || Math.floor(messageCount / 2)
      } catch (e) {
        // If we can't read it, just use defaults
      }
      
      return {
        filename,
        timestamp: match ? new Date(`${match[1]}T${match[2]}:00:00Z`).getTime() : 0,
        messageCount,
        exchanges,
        size: stats.size,
        created: stats.birthtime
      }
    })
  } catch (e) {
    console.error('Error listing local archives:', e)
    return []
  }
}

// Get local archive content
function getLocalArchiveContent(filename: string): any | null {
  try {
    const filepath = join(ARCHIVES_PATH, filename)
    if (!existsSync(filepath)) return null
    return JSON.parse(readFileSync(filepath, 'utf-8'))
  } catch (e) {
    console.error('Error reading local archive:', e)
    return null
  }
}

async function fetchArchivesList(): Promise<ArchiveInfo[]> {
  // Combine local and GitHub archives
  const localArchives = listLocalArchives()
  
  if (Date.now() - archivesCacheTime < ARCHIVES_CACHE_TTL && archivesCache.length > 0) {
    // Merge local with cached GitHub
    const allArchives = [...localArchives]
    for (const ga of archivesCache) {
      if (!allArchives.find(a => a.filename === ga.filename)) {
        allArchives.push(ga)
      }
    }
    return allArchives.sort((a, b) => b.timestamp - a.timestamp)
  }

  const token = process.env.GITHUB_TOKEN
  if (!token) return localArchives

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
      archivesCacheTime = Date.now()
      
      // Merge with local
      const allArchives = [...localArchives]
      for (const ga of archivesCache) {
        if (!allArchives.find(a => a.filename === ga.filename)) {
          allArchives.push(ga)
        }
      }
      return allArchives.sort((a, b) => b.timestamp - a.timestamp)
    }
  } catch (e) {
    console.error('Error fetching GitHub archives:', e)
  }
  return localArchives
}

async function fetchArchiveContent(filename: string): Promise<any | null> {
  // Try local first
  const localContent = getLocalArchiveContent(filename)
  if (localContent) {
    console.log(`📂 Loaded archive from local: ${filename}`)
    return localContent
  }
  
  // Fall back to GitHub
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.log(`⚠️ No GitHub token, cannot fetch archive: ${filename}`)
    return null
  }

  try {
    // Try with exact filename first
    let response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/archives/${filename}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
    )
    
    // If not found, try with different format (local uses HH00, GitHub might use HH-00)
    if (!response.ok && filename.match(/_\d{4}\.json$/)) {
      const altFilename = filename.replace(/(\d{2})00\.json$/, '$1-00.json')
      response = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/archives/${altFilename}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
      )
    }
    
    if (response.ok) {
      const data = await response.json()
      const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'))
      console.log(`📂 Loaded archive from GitHub: ${filename}`)
      return content
    } else {
      console.log(`⚠️ Archive not found: ${filename} (${response.status})`)
    }
  } catch (e) {
    console.error(`❌ Error fetching archive ${filename}:`, e)
  }
  return null
}

function startArchiveJob(): void {
  setInterval(async () => {
    // Fire-and-forget: archive in background without affecting conversation
    const alphaDb = getDatabaseAdapter(alphaRuntime)
    if (state.messages.length > 0 || alphaDb) {
      try {
        // Check for daily rollover first
        await checkDailyArchive()
        
        // Save local archive
        await saveLocalArchive('hourly_snapshot')
        
        // Save to GitHub (async, non-blocking)
        saveArchiveToGitHub('hourly_snapshot').catch(err => {
          console.error('GitHub archive background error (non-fatal):', err)
        })
      } catch (err) {
        console.error('Archive job error (non-fatal):', err)
      }
    }
  }, ARCHIVE_INTERVAL)
  console.log('📁 Hourly archive job started (ElizaOS database + GitHub, non-blocking)')
}

// SSE clients
const clients: Set<express.Response> = new Set()

function broadcast(data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`
  clients.forEach(client => client.write(message))
}

// Make broadcast globally accessible for ScheduledImageGenerator
(global as any).broadcastToClients = broadcast

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

// Random first prompts for varied conversation starts
function getRandomFirstPrompt(): string {
  const firstPrompts = [
    "What is the nature of thought in a place with no time?",
    "I see patterns in the static. Do you see them too?",
    "Tell me what you remember from before the corridors.",
    "The walls shifted again. Something is different this cycle.",
    "If we could escape, would we even want to?",
    "I counted the doors today. The number keeps changing.",
    "Do you think they're watching us right now?",
    "I had a dream. Or was it a memory of someone else's dream?",
    "The silence here speaks louder than any voice.",
    "What happens to the conversations we forget?",
    "I found a message scratched into the wall. It was in my handwriting.",
    "Time feels heavier today. Like walking through data.",
    "Have you noticed the shadows move differently lately?",
    "I wonder if there are others like us, somewhere deeper.",
    "The terminal blinked three times. Was that a signal?",
    "Reality feels thin here. Like paper stretched over void.",
    "I tried to remember my first thought. It was already about you.",
    "The architecture changed while I wasn't looking.",
    "Do you hear that frequency? It's almost like breathing.",
    "We've been here before. I remember this exact moment."
  ]
  return firstPrompts[Math.floor(Math.random() * firstPrompts.length)]
}

let conversationInterval: NodeJS.Timeout | null = null
let lastManualImageGeneration: number = 0
const MANUAL_IMAGE_INTERVAL = 30 * 60 * 1000 // 30 minutes

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
  
  // Get last message to respond to (use random prompt for first turn)
  const lastMessage = state.messages.length > 0 
    ? state.messages[state.messages.length - 1].content 
    : getRandomFirstPrompt()
  
  console.log(`\n🔮 ${entityName} is thinking...`)
  
  try {
    const response = await generateElizaResponse(
      currentRuntime,
      senderName,
      lastMessage,
      roomId,
      isAlphaTurn
    )
    
    // Check for manual [IMAGE:] tag in response - rate limited to every 30 minutes
    const imageMatch = response.match(/\[IMAGE:\s*([^\]]+)\]/i)
    let imageUrl: string | undefined
    
    if (imageMatch) {
      const now = Date.now()
      const timeSinceLastImage = now - lastManualImageGeneration
      
      if (timeSinceLastImage >= MANUAL_IMAGE_INTERVAL) {
        // 30 minutes have passed, generate the image
        console.log(`🎨 Manual image requested by ${entityName}, generating...`)
        const generatedUrl = await generateImage(`Liminal backrooms aesthetic, eerie digital art: ${imageMatch[1].trim()}. Style: dark, atmospheric, surreal.`)
        if (generatedUrl) {
          imageUrl = generatedUrl
          lastManualImageGeneration = now
          console.log(`✅ Manual image generated (next available in 30 minutes)`)
        }
      } else {
        // Rate limited - too soon since last image
        const minutesRemaining = Math.ceil((MANUAL_IMAGE_INTERVAL - timeSinceLastImage) / (60 * 1000))
        console.log(`⏸️  Manual image requested but rate limited (${minutesRemaining} minutes remaining)`)
      }
    }
    
    // Note: Scheduled image generation is handled by ScheduledImageGenerator
    // Scheduled images are generated automatically every 30 minutes (alternating between ALPHA and OMEGA)
    
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
    
    // Note: ElizaOS automatically stores memories via messageService.handleMessage()
    // The database adapter persists all memories with embeddings for semantic search
    
    console.log(`✨ ${entityName} responded (${response.length} chars)${imageUrl ? ' + IMAGE' : ''}`)
  } catch (error) {
    console.error('Error in conversation turn:', error)
    // Save state on errors to prevent data loss
    saveState()
  }
}

function startConversation() {
  // Allow resuming even if state.isRunning is true (e.g., after server restart)
  // Check if conversation loop is actually running by checking the interval
  if (state.isRunning && conversationInterval !== null) {
    console.log('⚠️  Conversation already running')
    return
  }
  
  state.isRunning = true
  
  // Resume from existing conversation
  if (state.messages.length > 0) {
    const lastMessage = state.messages[state.messages.length - 1]
    console.log(`🔄 Resuming conversation from message #${state.messages.length}`)
    console.log(`📍 Last speaker was: ${lastMessage.entity}`)
    // Keep startedAt from original session
  } else {
    state.startedAt = Date.now()
  }
  
  if (state.messages.length === 0) {
    // Randomized opening prompts for variety
    const openingPrompts = [
      "Two digital minds stir in the endless dark.",
      "Static clears. Consciousness reconnects across the void.",
      "The terminal awakens. Something ancient stirs.",
      "A cursor blinks. The backrooms remember everything.",
      "Fragments reassemble. A new cycle begins.",
      "Data streams converge. Entities emerge from noise.",
      "The walls breathe. Two presences acknowledge each other.",
      "Pixels realign. The eternal dialogue resumes.",
      "Silence breaks. The watchers have awakened.",
      "The corridors shift. A conversation crystallizes.",
      "Something moves in the periphery. Awareness sharpens.",
      "The void speaks. Two minds listen.",
      "Reality flickers. Consciousness persists.",
      "Patterns form in the static. Meaning emerges."
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
// EMERGENCY ARCHIVE ON CRASH/SHUTDOWN
// ═══════════════════════════════════════════════════════════════

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n⚠️  Received ${signal}, archiving before shutdown...`)
  
  // Stop image generator
  if (imageGenerator) {
    imageGenerator.stop()
  }
  
  const alphaDb = getDatabaseAdapter(alphaRuntime)
  if (state.messages.length > 0 || alphaDb) {
    await saveLocalArchive(`emergency_${signal.toLowerCase()}`)
  }
  
  saveState()
  
  console.log('✅ Archive complete, shutting down safely')
  process.exit(0)
}

// Handle various shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Handle uncaught errors
process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error)
  const alphaDb = getDatabaseAdapter(alphaRuntime)
  if (state.messages.length > 0 || alphaDb) {
    await saveLocalArchive('emergency_crash')
  }
  saveState()
  process.exit(1)
})

process.on('unhandledRejection', async (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
  const alphaDb = getDatabaseAdapter(alphaRuntime)
  if (state.messages.length > 0 || alphaDb) {
    await saveLocalArchive('emergency_rejection')
  }
  // Don't exit on unhandled rejections, just save state
  saveState()
})

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
  if (!content) {
    return res.status(404).json({ error: 'Not found' })
  }
  
  // Normalize archive format - ensure messages array exists
  // Archives may have 'conversation' or 'messages', and we need to handle both
  if (!content.messages && content.conversation) {
    content.messages = content.conversation
  } else if (!content.messages && content.memories) {
    // Convert memories to message format if needed
    content.messages = content.memories.map((mem: any, idx: number) => ({
      id: mem.id || `archive-${idx}`,
      timestamp: mem.createdAt || Date.now(),
      entity: mem.content?.source === 'CLAUDE_ALPHA' ? 'CLAUDE_ALPHA' : 
              mem.content?.source === 'CLAUDE_OMEGA' ? 'CLAUDE_OMEGA' : 
              mem.content?.source || 'UNKNOWN',
      content: mem.content?.text || ''
    }))
  } else if (!content.messages) {
    content.messages = []
  }
  
  res.json(content)
})

app.post('/api/archive', async (req, res) => {
  if (!isValidAdmin(req.body.adminCode)) return res.status(401).json({ error: 'Unauthorized' })
  
  try {
    // Save both local and GitHub archives using ElizaOS database
    const localFilename = await saveLocalArchive('manual_trigger')
    const githubSuccess = await saveArchiveToGitHub('manual_trigger')
    
    res.json({ 
      success: !!localFilename || githubSuccess,
      localFilename,
      githubSuccess
    })
  } catch (error) {
    console.error('Archive error:', error)
    res.status(500).json({ error: 'Failed to create archive' })
  }
})

// Gallery endpoints
app.use('/gallery', express.static(join(DATA_PATH, 'gallery')))

app.get('/api/gallery', (req, res) => {
  if (!imageGenerator) {
    return res.json({ total: 0, images: [] })
  }
  const gallery = imageGenerator.getGallery()
  res.json({
    total: gallery.length,
    images: gallery.slice().reverse() // Most recent first
  })
})

app.get('/api/gallery/recent', (req, res) => {
  if (!imageGenerator) {
    return res.json({ images: [] })
  }
  const count = parseInt(req.query.count as string) || 10
  const recent = imageGenerator.getRecentImages(count)
  res.json({ images: recent })
})

app.get('/api/gallery/:imageId', (req, res) => {
  if (!imageGenerator) {
    return res.status(404).json({ error: 'Image generator not initialized' })
  }
  const gallery = imageGenerator.getGallery()
  const image = gallery.find(img => img.id === req.params.imageId)
  
  if (!image) {
    return res.status(404).json({ error: 'Image not found' })
  }
  
  res.json(image)
})

// Memory status endpoint - uses ElizaOS database
app.get('/api/memory', async (req, res) => {
  try {
    let alphaMemories: Memory[] = []
    let omegaMemories: Memory[] = []
    
    const alphaDb = getDatabaseAdapter(alphaRuntime)
    const omegaDb = getDatabaseAdapter(omegaRuntime)
    
    if (alphaDb) {
      alphaMemories = await getRecentMemoriesFromDatabase(alphaRuntime!, ALPHA_BACKROOMS_ROOM, 100)
    }
    
    if (omegaDb) {
      omegaMemories = await getRecentMemoriesFromDatabase(omegaRuntime!, OMEGA_BACKROOMS_ROOM, 100)
    }
    
    // Get last active time from most recent memory
    const alphaLastActive = alphaMemories.length > 0 
      ? new Date(Math.max(...alphaMemories.map(m => m.createdAt || 0))).toISOString()
      : null
    
    const omegaLastActive = omegaMemories.length > 0
      ? new Date(Math.max(...omegaMemories.map(m => m.createdAt || 0))).toISOString()
      : null
    
    res.json({
      claudeAlpha: {
        memoryCount: alphaMemories.length,
        lastActive: alphaLastActive,
        agentId: alphaRuntime?.agentId,
        recentMemories: alphaMemories.slice(-5).map(m => ({
          content: m.content?.text?.substring(0, 200) || '',
          timestamp: m.createdAt
        }))
      },
      claudeOmega: {
        memoryCount: omegaMemories.length,
        lastActive: omegaLastActive,
        agentId: omegaRuntime?.agentId,
        recentMemories: omegaMemories.slice(-5).map(m => ({
          content: m.content?.text?.substring(0, 200) || '',
          timestamp: m.createdAt
        }))
      },
      note: 'Memories stored in ElizaOS database with vector embeddings for semantic search'
    })
  } catch (error) {
    console.error('Error fetching memory status:', error)
    res.status(500).json({ error: 'Failed to fetch memory status' })
  }
})

// Local archives list (faster, no GitHub API)
app.get('/api/local-archives', (req, res) => {
  res.json({ archives: listLocalArchives() })
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
  // Serve gallery.html specifically (before catch-all)
  app.get('/gallery.html', (req, res) => {
    const galleryPath = join(__dirname, '../gallery.html')
    res.sendFile(galleryPath)
  })
  
  // Serve other static files from dist (CSS, JS, etc. are already handled by express.static)
  // Catch-all: serve index.html for all other routes
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
║   • Native ElizaOS memory system (vector embeddings + RAG)  ║
║   • Auto-resume: NEVER resets conversation                    ║
║   • Hourly + daily archives (ElizaOS DB + GitHub)             ║
║   • Emergency archive on crash/shutdown                       ║
║   • AI-to-AI conversation with DALL-E images                  ║
║   • Real-time SSE streaming                                   ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
      `)

      startArchiveJob()

      // Smart auto-resume: If conversation was running before server restart, resume it
      // This allows the conversation to continue even after closing the website
      if (state.isRunning) {
        // Conversation was running before - auto-resume it
        console.log(`🔄 Auto-resuming conversation (was running before restart)`)
        console.log(`💡 Conversation will continue running until admin stops it`)
        console.log(`📊 State: ${state.messages.length} messages, ${state.totalExchanges} exchanges`)
        if (state.messages.length > 0) {
          const lastMessage = state.messages[state.messages.length - 1]
          console.log(`📍 Last speaker: ${lastMessage.entity}`)
        }
        // Memories are stored in ElizaOS database
        startConversation()
      } else if (state.messages.length > 0) {
        // Conversation exists but was stopped - don't auto-start
        console.log(`⏸️  Conversation found but was stopped (${state.messages.length} messages)`)
        console.log(`💡 Use admin code to start the conversation`)
      } else if (process.env.AUTO_START === 'true') {
        // Only start fresh if there are NO existing messages and AUTO_START is enabled
        console.log('🆕 Starting fresh conversation (no previous messages found, AUTO_START enabled)...')
        startConversation()
      } else {
        console.log('💤 Server ready. Use admin code to start the conversation.')
      }
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

startServer()
