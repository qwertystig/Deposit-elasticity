using Microsoft.AspNetCore.Mvc.RazorPages;

namespace DepositElasticity.Pages
{
    public class ChatModel : PageModel
    {
        public string UserName { get; set; } = "Guest";
        public string UserInitials { get; set; } = "GU";

        public void OnGet()
        {
            var email = HttpContext.Session.GetString("Email");
            if (!string.IsNullOrEmpty(email))
            {
                UserName = email.Split('@')[0];
                UserInitials = UserName.Length >= 2 ? UserName.Substring(0, 2).ToUpper() : UserName.ToUpper();
            }
        }
    }
}
