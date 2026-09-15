using Microsoft.Data.Sqlite;

namespace DepositElasticity.Services
{
    public class ChatSession
    {
        public string Id { get; set; } = "";
        public string? Title { get; set; }
        public string? ConversationId { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
    }

    public class ChatMessage
    {
        public string Role { get; set; } = "";   // "user" | "agent"
        public string Content { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    /// <summary>
    /// Persists chat sessions and their message history to a local SQLite file, so a user
    /// can start multiple named analyses ("New analysis") and resume any earlier one later.
    ///
    /// What's actually persisted here — and, just as importantly, what isn't:
    ///   - Purple Fabric's own conversation_id IS persisted (per session). That's the real
    ///     "resume token" — passing it back into SendMessageAsync is what continues the same
    ///     thread on Purple Fabric's side.
    ///   - The OAuth bearer access_token is NOT persisted here, deliberately. It's short-lived,
    ///     fetched fresh (or refreshed on 401) by ConversationAgentService on every call using
    ///     the API key/username/password already in appsettings.json — there's nothing durable
    ///     to store, and storing a copy would just create a second place for it to go stale.
    /// </summary>
    public class SessionStore
    {
        private readonly string _connectionString;

        public SessionStore(string dbPath)
        {
            var dir = Path.GetDirectoryName(dbPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            _connectionString = $"Data Source={dbPath}";
            EnsureSchema();
        }

        private SqliteConnection Open()
        {
            var conn = new SqliteConnection(_connectionString);
            conn.Open();
            return conn;
        }

        private void EnsureSchema()
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"
                CREATE TABLE IF NOT EXISTS Sessions (
                    Id TEXT PRIMARY KEY,
                    UserEmail TEXT NOT NULL,
                    Title TEXT,
                    ConversationId TEXT,
                    CreatedAt TEXT NOT NULL,
                    UpdatedAt TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS Messages (
                    Id INTEGER PRIMARY KEY AUTOINCREMENT,
                    SessionId TEXT NOT NULL REFERENCES Sessions(Id),
                    Role TEXT NOT NULL,
                    Content TEXT NOT NULL,
                    CreatedAt TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_user ON Sessions(UserEmail, UpdatedAt);
                CREATE INDEX IF NOT EXISTS idx_messages_session ON Messages(SessionId, Id);
            ";
            cmd.ExecuteNonQuery();
        }

        public ChatSession CreateSession(string userEmail)
        {
            var id = Guid.NewGuid().ToString();
            var now = DateTime.UtcNow;

            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"INSERT INTO Sessions (Id, UserEmail, Title, ConversationId, CreatedAt, UpdatedAt)
                                 VALUES ($id, $email, NULL, NULL, $now, $now)";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.Parameters.AddWithValue("$email", userEmail);
            cmd.Parameters.AddWithValue("$now", now.ToString("o"));
            cmd.ExecuteNonQuery();

            return new ChatSession { Id = id, Title = null, ConversationId = null, CreatedAt = now, UpdatedAt = now };
        }

        public List<ChatSession> GetSessions(string userEmail)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"SELECT Id, Title, ConversationId, CreatedAt, UpdatedAt
                                 FROM Sessions WHERE UserEmail = $email ORDER BY UpdatedAt DESC";
            cmd.Parameters.AddWithValue("$email", userEmail);

            var result = new List<ChatSession>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                result.Add(new ChatSession
                {
                    Id = reader.GetString(0),
                    Title = reader.IsDBNull(1) ? null : reader.GetString(1),
                    ConversationId = reader.IsDBNull(2) ? null : reader.GetString(2),
                    CreatedAt = DateTime.Parse(reader.GetString(3)),
                    UpdatedAt = DateTime.Parse(reader.GetString(4)),
                });
            }
            return result;
        }

        /// <summary>Returns the session only if it belongs to the given user — callers must
        /// check for null rather than trusting a bare session id from the client.</summary>
        public ChatSession? GetSession(string sessionId, string userEmail)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"SELECT Id, Title, ConversationId, CreatedAt, UpdatedAt
                                 FROM Sessions WHERE Id = $id AND UserEmail = $email";
            cmd.Parameters.AddWithValue("$id", sessionId);
            cmd.Parameters.AddWithValue("$email", userEmail);

            using var reader = cmd.ExecuteReader();
            if (!reader.Read()) return null;
            return new ChatSession
            {
                Id = reader.GetString(0),
                Title = reader.IsDBNull(1) ? null : reader.GetString(1),
                ConversationId = reader.IsDBNull(2) ? null : reader.GetString(2),
                CreatedAt = DateTime.Parse(reader.GetString(3)),
                UpdatedAt = DateTime.Parse(reader.GetString(4)),
            };
        }

        public void SetConversationId(string sessionId, string conversationId)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "UPDATE Sessions SET ConversationId = $cid WHERE Id = $id";
            cmd.Parameters.AddWithValue("$cid", conversationId);
            cmd.Parameters.AddWithValue("$id", sessionId);
            cmd.ExecuteNonQuery();
        }

        /// <summary>Sets the title from the first user message, but only if it isn't
        /// already set — later messages never overwrite an established title.</summary>
        public void SetTitleIfUnset(string sessionId, string title)
        {
            var trimmed = title.Length > 60 ? title.Substring(0, 60) + "…" : title;
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "UPDATE Sessions SET Title = $title WHERE Id = $id AND Title IS NULL";
            cmd.Parameters.AddWithValue("$title", trimmed);
            cmd.Parameters.AddWithValue("$id", sessionId);
            cmd.ExecuteNonQuery();
        }

        public void Touch(string sessionId)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "UPDATE Sessions SET UpdatedAt = $now WHERE Id = $id";
            cmd.Parameters.AddWithValue("$now", DateTime.UtcNow.ToString("o"));
            cmd.Parameters.AddWithValue("$id", sessionId);
            cmd.ExecuteNonQuery();
        }

        public void AddMessage(string sessionId, string role, string content)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"INSERT INTO Messages (SessionId, Role, Content, CreatedAt)
                                 VALUES ($sid, $role, $content, $now)";
            cmd.Parameters.AddWithValue("$sid", sessionId);
            cmd.Parameters.AddWithValue("$role", role);
            cmd.Parameters.AddWithValue("$content", content);
            cmd.Parameters.AddWithValue("$now", DateTime.UtcNow.ToString("o"));
            cmd.ExecuteNonQuery();
        }

        public List<ChatMessage> GetMessages(string sessionId)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"SELECT Role, Content, CreatedAt FROM Messages
                                 WHERE SessionId = $sid ORDER BY Id ASC";
            cmd.Parameters.AddWithValue("$sid", sessionId);

            var result = new List<ChatMessage>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                result.Add(new ChatMessage
                {
                    Role = reader.GetString(0),
                    Content = reader.GetString(1),
                    CreatedAt = DateTime.Parse(reader.GetString(2)),
                });
            }
            return result;
        }
    }
}
