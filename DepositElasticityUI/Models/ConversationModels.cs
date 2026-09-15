namespace DepositElasticity.Models
{
    public class ConversationMessage
    {
        public string Role { get; set; } = ""; // "user" or "agent"
        public string Text { get; set; } = "";
        public string? FileName { get; set; }
        public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    }

    public class ConversationSendResponse
    {
        public bool Success { get; set; }
        public string? Reply { get; set; }
        public string? Error { get; set; }
        public List<GeneratedFileInfo>? Files { get; set; }
    }

    public class GeneratedFileInfo
    {
        public string FileName { get; set; } = "";
    }

    public class ConversationHistoryResponse
    {
        public List<ConversationMessage> Messages { get; set; } = new();
    }
}